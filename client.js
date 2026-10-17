/**
 * phone-bridge — Client half.
 *
 * Adds one page under Settings ("手机同步") that manages the bridge:
 * tunnel status, pairing QR code, pairing URL, the default
 * "return reasoning too" switch, and the target session.
 *
 * Plain-JS Client half: registers a lazy factory into the module table and
 * renders with React from the browser module table. Styles use only
 * `--dsw-alias-*` theme tokens.
 */

window.__ModuleLoader__.load({
  // MUST equal package.json `name`: the host builds the front-end module graph
  // from the package name and imports that id, so any other string here makes
  // the boot fail with "loaded without registering ..." plus a duplicate
  // registration on the loader's single-package retry.
  id: 'dsh-phone-bridge',
  factory(require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement

    var NS = 'settings.phone-bridge'
    var API = '/phone-bridge/api'

    var zh = {
      title: '手机同步',
      intro: '手机通过内网穿透隧道连接本机 DSH：手机可以发送文字与拍照图片，Agent 的回复会回到手机上。',
      statusLabel: '隧道状态',
      statusStopped: '未启动',
      statusStarting: '启动中…',
      statusRunning: '已连接',
      statusError: '出错',
      start: '启动隧道',
      stop: '停止隧道',
      starting: '启动中…',
      refresh: '刷新',
      pairTitle: '手机配对',
      pairHint: '用手机 App 扫描二维码，或手动复制下面的地址填写到 App 中。',
      copy: '复制地址',
      copied: '已复制',
      noUrl: '隧道尚未就绪，请先启动隧道。',
      tokenLabel: '配对密钥',
      sessionTitle: '目标会话',
      sessionLabel: '当前会话',
      sessionNone: '（尚未创建，首次发送时自动创建）',
      newSession: '新建会话',
      prefsTitle: '回复内容',
      thinkingLabel: '手机上也返回思考过程',
      thinkingHint: '关闭时手机只显示最终结果；打开后手机的回复里会附带模型的思考内容。',
      busy: '处理中…',
      failed: '操作失败',
      unreachable: '无法连接到插件服务',
      tail: '隧道输出',
    }
    var en = {
      title: 'Phone Sync',
      intro:
        'Connect a phone to this DSH over a tunnel: the phone sends text and photos, and the Agent reply returns to the phone.',
      statusLabel: 'Tunnel',
      statusStopped: 'Stopped',
      statusStarting: 'Starting…',
      statusRunning: 'Connected',
      statusError: 'Error',
      start: 'Start tunnel',
      stop: 'Stop tunnel',
      starting: 'Starting…',
      refresh: 'Refresh',
      pairTitle: 'Pair a phone',
      pairHint: 'Scan the QR code with the phone app, or copy the address below into the app.',
      copy: 'Copy address',
      copied: 'Copied',
      noUrl: 'The tunnel is not ready yet — start it first.',
      tokenLabel: 'Pairing token',
      sessionTitle: 'Target session',
      sessionLabel: 'Current session',
      sessionNone: '(not created yet — created automatically on first send)',
      newSession: 'New session',
      prefsTitle: 'Reply content',
      thinkingLabel: 'Also return the reasoning stream to the phone',
      thinkingHint:
        'Off: the phone shows only the final result. On: the phone reply also carries the model reasoning.',
      busy: 'Working…',
      failed: 'Failed',
      unreachable: 'Cannot reach the plugin service',
      tail: 'Tunnel output',
    }

    function api(path, init) {
      return fetch(API + path, Object.assign({ headers: { accept: 'application/json' } }, init || {}))
        .then(function (res) {
          return res.json().then(function (body) {
            if (!res.ok || body.ok === false) {
              throw new Error((body && body.error) || 'HTTP ' + res.status)
            }
            return body
          })
        })
    }

    function post(path, body) {
      return api(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body || {}),
      })
    }

    var CSS = [
      '.pb-root{box-sizing:border-box;display:flex;flex-direction:column;gap:18px;padding:4px 2px 28px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.55}',
      '.pb-intro{color:var(--dsw-alias-label-secondary);margin:0}',
      '.pb-card{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:14px 16px;background:var(--dsw-alias-bg-layer-2);display:flex;flex-direction:column;gap:10px}',
      '.pb-card-title{font-weight:600;font-size:13px}',
      '.pb-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.pb-row-between{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}',
      '.pb-label{color:var(--dsw-alias-label-secondary);min-width:80px}',
      '.pb-muted{color:var(--dsw-alias-label-secondary)}',
      '.pb-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;word-break:break-all}',
      '.pb-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);padding:6px 12px;font-size:12px;cursor:pointer}',
      '.pb-btn:hover:enabled{background:var(--dsw-alias-interactive-bg-hover)}',
      '.pb-btn:disabled{opacity:.5;cursor:default}',
      '.pb-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-inverse, #fff)}',
      '.pb-dot{width:8px;height:8px;border-radius:999px;display:inline-block;flex:none}',
      '.pb-dot-running{background:var(--dsw-alias-status-success, #2e9e5b)}',
      '.pb-dot-starting{background:var(--dsw-alias-status-warning, #d09021)}',
      '.pb-dot-error{background:var(--dsw-alias-status-error, #d04848)}',
      '.pb-dot-stopped{background:var(--dsw-alias-label-dimmed)}',
      '.pb-qr{width:190px;height:190px;background:#fff;border-radius:10px;padding:8px;box-sizing:border-box}',
      '.pb-url{flex:1;min-width:220px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px 10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.pb-switch{display:inline-flex;align-items:center;gap:8px;cursor:pointer;user-select:none}',
      '.pb-switch input{width:15px;height:15px;accent-color:var(--dsw-alias-brand-primary)}',
      '.pb-err{color:var(--dsw-alias-status-error, #d04848)}',
      '.pb-pre{margin:0;max-height:150px;overflow:auto;background:var(--dsw-alias-bg-layer-1);border-radius:8px;padding:8px 10px;font-size:11px;white-space:pre-wrap}',
      '.pb-hr{height:1px;background:var(--dsw-alias-border-l2);border:0;margin:0}',
    ].join('')

    function useStyleOnce() {
      React.useEffect(function () {
        var tag = document.querySelector('style[data-plugin-css="phone-bridge/panel.css"]')
        if (tag) return undefined
        var el = document.createElement('style')
        el.dataset.plugin = 'phone-bridge'
        el.dataset.pluginCss = 'phone-bridge/panel.css'
        el.textContent = CSS
        document.head.appendChild(el)
        return undefined
      }, [])
    }

    function Panel(props) {
      var t = props.t || function (k) { return zh[k] || k }
      useStyleOnce()
      var state = React.useState(null)
      var status = state[0]
      var setStatus = state[1]
      var errState = React.useState('')
      var error = errState[0]
      var setError = errState[1]
      var busyState = React.useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]
      var copiedState = React.useState(false)
      var copied = copiedState[0]
      var setCopied = copiedState[1]

      var load = React.useCallback(function () {
        return api('/status')
          .then(function (body) {
            setStatus(body)
            setError('')
          })
          .catch(function (e) {
            setError(String((e && e.message) || e))
          })
      }, [])

      React.useEffect(function () {
        var alive = true
        load()
        var timer = window.setInterval(function () {
          if (alive) load()
        }, 2500)
        return function () {
          alive = false
          window.clearInterval(timer)
        }
      }, [load])

      var run = function (fn) {
        setBusy(true)
        fn()
          .catch(function (e) {
            setError(String((e && e.message) || e))
          })
          .then(function () {
            setBusy(false)
            return load()
          })
      }

      var tunnel = (status && status.tunnel) || { status: 'stopped' }
      var running = tunnel.status === 'running'
      var dotClass = 'pb-dot pb-dot-' + (tunnel.status || 'stopped')
      var statusText =
        tunnel.status === 'running'
          ? t('statusRunning')
          : tunnel.status === 'starting'
            ? t('statusStarting')
            : tunnel.status === 'error'
              ? t('statusError')
              : t('statusStopped')

      var pairUrl = (status && status.pairUrl) || ''
      var qrSrc = '/phone-bridge/qr.svg?token=' + encodeURIComponent((status && status.token) || '')

      var onCopy = function () {
        var text = pairUrl
        if (!text) return
        var done = function () {
          setCopied(true)
          window.setTimeout(function () {
            setCopied(false)
          }, 1400)
        }
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done, done)
            return
          }
        } catch (e) {
          /* fall through */
        }
        try {
          var ta = document.createElement('textarea')
          ta.value = text
          document.body.appendChild(ta)
          ta.select()
          document.execCommand('copy')
          document.body.removeChild(ta)
          done()
        } catch (e) {
          /* ignore */
        }
      }

      return h(
        'div',
        { className: 'pb-root' },
        h('p', { className: 'pb-intro' }, t('intro')),

        h(
          'div',
          { className: 'pb-card' },
          h(
            'div',
            { className: 'pb-row-between' },
            h(
              'div',
              { className: 'pb-row' },
              h('span', { className: dotClass }),
              h('span', { className: 'pb-card-title' }, t('statusLabel')),
              h('span', { className: 'pb-muted' }, statusText),
            ),
            h(
              'div',
              { className: 'pb-row' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'pb-btn',
                  disabled: busy,
                  onClick: function () {
                    load()
                  },
                },
                t('refresh'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'pb-btn' + (running ? '' : ' pb-btn-primary'),
                  disabled: busy,
                  onClick: function () {
                    run(function () {
                      return post('/tunnel', { action: running ? 'stop' : 'start' })
                    })
                  },
                },
                busy ? t('busy') : running ? t('stop') : t('start'),
              ),
            ),
          ),
          tunnel.error
            ? h('div', { className: 'pb-err pb-mono' }, String(tunnel.error))
            : null,
          tunnel.tail
            ? h('pre', { className: 'pb-pre' }, String(tunnel.tail))
            : null,
        ),

        h(
          'div',
          { className: 'pb-card' },
          h('div', { className: 'pb-card-title' }, t('pairTitle')),
          h('p', { className: 'pb-muted', style: { margin: 0 } }, t('pairHint')),
          pairUrl
            ? h(
                'div',
                { className: 'pb-row' },
                h('img', { className: 'pb-qr', src: qrSrc, alt: 'pairing qr' }),
                h(
                  'div',
                  { style: { flex: 1, minWidth: 220, display: 'flex', flexDirection: 'column', gap: 8 } },
                  h(
                    'div',
                    { className: 'pb-row' },
                    h('div', { className: 'pb-url pb-mono', title: pairUrl }, pairUrl),
                    h(
                      'button',
                      { type: 'button', className: 'pb-btn', onClick: onCopy },
                      copied ? t('copied') : t('copy'),
                    ),
                  ),
                  h(
                    'div',
                    { className: 'pb-mono pb-muted' },
                    t('tokenLabel') + ': ' + String((status && status.token) || ''),
                  ),
                ),
              )
            : h('div', { className: 'pb-muted' }, t('noUrl')),
        ),

        h(
          'div',
          { className: 'pb-card' },
          h('div', { className: 'pb-card-title' }, t('sessionTitle')),
          h(
            'div',
            { className: 'pb-row-between' },
            h(
              'div',
              { className: 'pb-row' },
              h('span', { className: 'pb-label' }, t('sessionLabel')),
              status && status.sessionId
                ? h('span', { className: 'pb-mono' }, status.sessionId)
                : h('span', { className: 'pb-muted' }, t('sessionNone')),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'pb-btn',
                disabled: busy,
                onClick: function () {
                  run(function () {
                    return post('/prefs', { newSession: true })
                  })
                },
              },
              t('newSession'),
            ),
          ),
        ),

        h(
          'div',
          { className: 'pb-card' },
          h('div', { className: 'pb-card-title' }, t('prefsTitle')),
          h(
            'label',
            { className: 'pb-switch' },
            h('input', {
              type: 'checkbox',
              checked: !!(status && status.defaultShowThinking),
              disabled: busy || !status,
              onChange: function (e) {
                var next = !!(e.target && e.target.checked)
                run(function () {
                  return post('/prefs', { defaultShowThinking: next })
                })
              },
            }),
            h('span', null, t('thinkingLabel')),
          ),
          h('div', { className: 'pb-muted' }, t('thinkingHint')),
        ),

        error ? h('div', { className: 'pb-err' }, t('failed') + ': ' + error) : null,
      )
    }

    /**
     * A throwing component blanks its slot entry, so the panel sits inside a
     * real error boundary that degrades to a readable message.
     */
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error: String((error && error.message) || error) }
      }

      componentDidCatch(error) {
        try {
          console.error('[phone-bridge] settings panel failed', error)
        } catch (e) {
          /* ignore */
        }
      }

      render() {
        if (this.state.error) {
          return h(
            'div',
            { className: 'pb-root' },
            h('p', { className: 'pb-err' }, '手机同步面板出错：' + this.state.error),
          )
        }
        return h(Panel, this.props)
      }
    }

    function apply(ctx) {
      var t = function (key) {
        return zh[key] || key
      }

      // Dictionaries are a nicety: never let a locale failure stop the page
      // from registering. Falls back to the bundled Chinese strings.
      try {
        var locale = ctx.locale
        if (locale && typeof locale.register === 'function') {
          ctx.effect(function () {
            try {
              return locale.register(NS, { zh: zh, en: en })
            } catch (e) {
              return undefined
            }
          }, 'phone-bridge: dictionaries')
          if (typeof locale.bind === 'function') {
            var bound = locale.bind(NS)
            t = function (key) {
              try {
                var hit = bound(key)
                return hit === key ? zh[key] || key : hit
              } catch (e) {
                return zh[key] || key
              }
            }
          }
        }
      } catch (e) {
        /* locale is optional */
      }

      if (!ctx.slots || typeof ctx.slots.inject !== 'function') return

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register(
          {
            name: 'settings.section',
            id: 'phone-bridge',
            order: 56,
            label: zh.title,
          },
          function Section() {
            return h(Boundary, { t: t })
          },
        )
      })
    }

    exports.name = 'phone-bridge-client'
    exports.inject = ['slots', 'locale']
    exports.apply = apply
    return module.exports
  },
})
