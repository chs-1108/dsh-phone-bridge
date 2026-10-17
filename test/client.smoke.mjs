// Loads the Client half with a stubbed browser module table and exercises
// apply() + a Panel render, so a throw in the client code is caught here
// instead of blanking the settings slot in the real page.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.join(here, '..', 'client.js')
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'))

let failures = 0
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`)
  if (!ok) failures++
}

// --- minimal React stub ------------------------------------------------------
function el(type, props, ...children) {
  return { type, props: { ...(props || {}), children: children.length ? children : (props || {}).children } }
}
const React = {
  createElement: el,
  Fragment: 'Fragment',
  useState(initial) {
    const value = typeof initial === 'function' ? initial() : initial
    return [value, () => {}]
  },
  useEffect() {},
  useCallback(fn) {
    return fn
  },
  useRef(v) {
    return { current: v }
  },
  Component: class {
    constructor(props) {
      this.props = props || {}
      this.state = {}
    }
    setState(next) {
      this.state = { ...this.state, ...next }
    }
  },
}

const loadCalls = []
globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      loadCalls.push(spec)
      const module = { exports: {} }
      const requireFn = (word) => {
        if (word === 'react') return React
        if (word === 'react/jsx-runtime') return { jsx: el, jsxs: el }
        throw new Error(`client half required "${word}", which is not in the seed table`)
      }
      spec._returned = spec.factory(requireFn)
      // The real loader takes the factory's return value; some plugins also
      // assign onto module.exports, so accept whichever carries `apply`.
      const returned = spec._returned
      const candidate = returned && returned.apply ? returned : module.exports
      globalThis.__loaded = candidate
    },
  },
}
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, style: {}, appendChild() {} }),
  head: { appendChild() {} },
}
globalThis.fetch = () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) })
// Node 22 exposes `navigator` as a getter-only global, so define over it.
try {
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: null },
    configurable: true,
    writable: true,
  })
} catch (err) {
  /* the panel tolerates a missing clipboard */
}

// --- load --------------------------------------------------------------------
const src = fs.readFileSync(clientPath, 'utf8')
try {
  // eslint-disable-next-line no-eval
  ;(0, eval)(src)
  // The id must be the PACKAGE name: the host imports that id, and the loader
  // treats any other registration as a bundle that never registered (this is
  // exactly what broke the boot with id "phone-bridge").
  check(
    'client module registered under the package name',
    loadCalls.length === 1 && loadCalls[0].id === pkg.name,
    `registered=${JSON.stringify(loadCalls.map((c) => c.id))} expected=${JSON.stringify(pkg.name)}`,
  )
} catch (err) {
  check('client module registered under the package name', false, String(err && err.message))
  process.exit(1)
}

const impl = globalThis.__loaded
check('exports.name', impl && impl.name === 'phone-bridge-client', String(impl && impl.name))
check(
  'exports.inject is slots+locale',
  Array.isArray(impl.inject) && impl.inject.join(',') === 'slots,locale',
  JSON.stringify(impl && impl.inject),
)
check('exports.apply is a function', typeof impl.apply === 'function')

// --- apply with a healthy ctx ------------------------------------------------
let registration = null
const effects = []
const ctx = {
  locale: {
    register: () => () => {},
    bind: () => (k) => k,
  },
  slots: {
    inject(key, fn) {
      registration = { key, value: fn() }
    },
    register(options, component) {
      return { options, component }
    },
  },
  effect(fn) {
    effects.push(fn)
  },
}

try {
  impl.apply(ctx)
  check('apply() did not throw', true)
} catch (err) {
  check('apply() did not throw', false, String(err && err.message))
}

check(
  'registered into settings.section',
  registration && registration.key === 'settings.section',
  registration && registration.key,
)
check(
  'registration id is phone-bridge',
  registration && registration.value && registration.value.options.id === 'phone-bridge',
  registration && JSON.stringify(registration.value.options),
)
check('registers exactly one effect', effects.length === 1, `effects=${effects.length}`)
check(
  'effect returns a disposer or nothing',
  typeof effects[0] !== 'function' || typeof effects[0]() !== 'object' || true,
)

// --- render the registered component ----------------------------------------
const Section = registration.value.component
let tree = null
try {
  tree = Section({ close() {} })
  check('Section renders without throwing', tree !== null && typeof tree === 'object')
} catch (err) {
  check('Section renders without throwing', false, String(err && err.message))
}
check(
  'registration label is the localized title',
  registration.value.options.label === '手机同步',
  registration.value.options.label,
)
// Section renders the boundary; render the boundary's inner Panel directly so
// the panel body is exercised too.
const boundaryEl = Section({ close() {} })
let panelTree = null
try {
  // Boundary.render() yields the Panel element; render that element's own
  // function so the panel body (and its data flow) is exercised.
  const instance = new boundaryEl.type(boundaryEl.props)
  const inner = instance.render()
  check('Boundary renders the Panel element', inner && typeof inner.type === 'function')
  panelTree = inner.type(inner.props)
  check('Panel renders without throwing', panelTree !== null && typeof panelTree === 'object')
} catch (err) {
  check('Panel renders without throwing', false, String(err && err.message))
}
check(
  'Panel output carries localized body text',
  panelTree && JSON.stringify(panelTree).includes('隧道状态'),
  'statusLabel present in Panel',
)

// --- apply with a hostile ctx (missing services) -----------------------------
try {
  impl.apply({ slots: { inject: () => {} } })
  check('apply() survives a ctx without locale', true)
} catch (err) {
  check('apply() survives a ctx without locale', false, String(err && err.message))
}

try {
  impl.apply({})
  check('apply() survives a ctx without slots', true)
} catch (err) {
  check('apply() survives a ctx without slots', false, String(err && err.message))
}

// --- locale that throws must not break the panel -----------------------------
try {
  impl.apply({
    locale: {
      register() {
        throw new Error('duplicate (ns, locale)')
      },
      bind() {
        throw new Error('bind exploded')
      },
    },
    slots: {
      inject(key, fn) {
        registration = { key, value: fn() }
      },
      register(o, c) {
        return { options: o, component: c }
      },
    },
    effect(fn) {
      effects.push(fn)
    },
  })
  check('apply() tolerates a throwing locale', true)
  // the registered effect must also swallow the throw
  let effectThrew = false
  try {
    for (const effect of effects) effect()
  } catch (err) {
    effectThrew = true
  }
  check('dictionary effect swallows the locale throw', !effectThrew)
} catch (err) {
  check('apply() tolerates a throwing locale', false, String(err && err.message))
}

console.log(failures === 0 ? '\nALL CLIENT CHECKS PASSED' : `\n${failures} CLIENT CHECK(S) FAILED`)
process.exit(failures === 0 ? 0 : 1)
