package com.dsh.phonebridge;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.net.HttpURLConnection;
import java.net.URL;

/** First-run pairing: scan the QR code shown in DSH Settings, or paste the URL. */
public final class SetupActivity extends Activity {

    private static final int REQ_SCAN = 3001;

    private EditText urlField;
    private EditText tokenField;
    private TextView statusView;
    private Button connectButton;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        if (BridgeConfig.paired(this)) {
            startActivity(new Intent(this, MainActivity.class));
            finish();
            return;
        }

        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(Color.WHITE);
        scroll.setFillViewport(true);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(20);
        root.setPadding(pad, dp(28), pad, dp(28));
        scroll.addView(root, new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        root.addView(title("DSH 手机同步"));
        root.addView(note("先在这台手机和电脑上都装好 Tailscale 并登录，然后在电脑端的 DSH 里打开"
                + "「设置 → 手机同步」，用下面的按钮扫描那里的二维码。"
                + "两端不用连同一个 Wi-Fi。"));
        root.addView(space(6));

        Button scan = new Button(this);
        scan.setText("扫描电脑上的二维码");
        scan.setAllCaps(false);
        scan.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                startActivityForResult(new Intent(SetupActivity.this, ScanActivity.class), REQ_SCAN);
            }
        });
        root.addView(scan);

        root.addView(space(12));
        root.addView(label("配对地址"));
        urlField = new EditText(this);
        urlField.setHint("http://100.x.y.z:19387/phone-bridge");
        urlField.setInputType(InputType.TYPE_TEXT_VARIATION_URI | InputType.TYPE_CLASS_TEXT);
        urlField.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        root.addView(urlField);

        root.addView(space(8));
        root.addView(label("配对密钥"));
        tokenField = new EditText(this);
        tokenField.setHint("设置页里显示的配对密钥");
        tokenField.setInputType(InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS | InputType.TYPE_CLASS_TEXT);
        tokenField.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        root.addView(tokenField);

        root.addView(space(16));
        connectButton = new Button(this);
        connectButton.setText("连接");
        connectButton.setAllCaps(false);
        connectButton.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                connect();
            }
        });
        root.addView(connectButton);

        root.addView(space(14));
        statusView = new TextView(this);
        statusView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        statusView.setTextColor(Color.parseColor("#b3261e"));
        root.addView(statusView);

        setContentView(scroll);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_SCAN && resultCode == RESULT_OK && data != null) {
            String text = data.getStringExtra(ScanActivity.EXTRA_RESULT);
            if (text != null && !text.trim().isEmpty()) {
                String token = BridgeConfig.tokenFromPairUrl(text);
                if (!token.isEmpty()) {
                    tokenField.setText(token);
                }
                urlField.setText(BridgeConfig.normalizeBase(text));
                if (!token.isEmpty()) {
                    connect();
                }
            }
        }
    }

    private void connect() {
        final String base = BridgeConfig.normalizeBase(urlField.getText().toString());
        final String token = tokenField.getText().toString().trim();
        if (base.isEmpty()) {
            statusView.setText("请先填写配对地址，或扫描二维码。");
            return;
        }
        if (!base.startsWith("http://") && !base.startsWith("https://")) {
            statusView.setText("配对地址需要以 http:// 或 https:// 开头。");
            return;
        }
        statusView.setTextColor(Color.parseColor("#555555"));
        statusView.setText("正在连接…");
        connectButton.setEnabled(false);

        new Thread(new Runnable() {
            @Override
            public void run() {
                final String error = probe(base + "/health");
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        connectButton.setEnabled(true);
                        if (error == null) {
                            BridgeConfig.save(SetupActivity.this, base, token);
                            startActivity(new Intent(SetupActivity.this, MainActivity.class));
                            finish();
                        } else {
                            statusView.setTextColor(Color.parseColor("#b3261e"));
                            statusView.setText("连接失败：" + error);
                        }
                    }
                });
            }
        }, "bridge-probe").start();
    }

    /** Returns null when the bridge answered correctly, else a message. */
    private static String probe(String url) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(12000);
            conn.setReadTimeout(12000);
            conn.setRequestMethod("GET");
            int code = conn.getResponseCode();
            if (code == 200) {
                return null;
            }
            return "服务返回 " + code;
        } catch (Exception e) {
            String msg = e.getMessage();
            return msg == null ? e.getClass().getSimpleName() : msg;
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }

    private TextView title(String text) {
        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22);
        tv.setTextColor(Color.parseColor("#111111"));
        tv.setPadding(0, 0, 0, dp(10));
        return tv;
    }

    private TextView note(String text) {
        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        tv.setTextColor(Color.parseColor("#555555"));
        tv.setLineSpacing(0f, 1.25f);
        return tv;
    }

    private TextView label(String text) {
        TextView tv = new TextView(this);
        tv.setText(text);
        tv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        tv.setTextColor(Color.parseColor("#777777"));
        tv.setGravity(Gravity.START);
        return tv;
    }

    private View space(int dpValue) {
        View v = new View(this);
        v.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(dpValue)));
        return v;
    }

    private int dp(int value) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value,
                getResources().getDisplayMetrics()));
    }

    static void toast(Activity activity, String text) {
        Toast.makeText(activity, text, Toast.LENGTH_SHORT).show();
    }
}
