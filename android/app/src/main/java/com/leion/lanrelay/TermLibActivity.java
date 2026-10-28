package com.leion.lanrelay;

import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 术语库管理（4.62）。
 *
 * <p><b>只能提申请，不能直接改库</b>（用户 2026-10-23 定的规矩，见 docs/19）：
 * 一个人随手改错，所有选了该库的会议都跟着错；而且改完无从追查。所以走审批流：
 * 用户 {@code POST /org/requests} → 管理员决定 → 通过才写进库。
 *
 * <p>对应接口：
 * <ul>
 *   <li>{@code GET /org/libraries} —— 库列表（名称 / 分类 / 条目数）</li>
 *   <li>{@code POST /org/requests} —— 提交申请（类型 add / update / delete）</li>
 *   <li>{@code GET /org/requests/mine} —— 我的申请（含状态）</li>
 *   <li>{@code POST /org/requests/<id>/withdraw} —— 撤回 pending</li>
 * </ul>
 */
public class TermLibActivity extends android.app.Activity {

    private static final String PREFS = "leion";

    private final Handler ui = new Handler(Looper.getMainLooper());
    private LanClient client;

    private TextView hint;
    private LinearLayout libList;
    private LinearLayout requestList;

    @Override
    protected void attachBaseContext(android.content.Context base) {
        super.attachBaseContext(UiLang.wrap(base));
    }

    @Override
    protected void onResume() {
        super.onResume();
        UiLang.trackShown(this);
        loadAll();
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.page_terms_lib);

        hint = findViewById(R.id.termsLibHint);
        libList = findViewById(R.id.termsLibList);
        requestList = findViewById(R.id.termsRequestList);
        findViewById(R.id.termsBack).setOnClickListener(v -> finish());

        SharedPreferences prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        client = new LanClient(prefs.getString("host", ""), prefs.getString("secret", ""), null);
        String token = prefs.getString("accountToken", "");
        if (token != null && !token.isEmpty()) client.setToken(token);
        if (token == null || token.isEmpty()) {
            hint.setText(getString(R.string.terms_need_login));
            return;
        }
        loadAll();
    }

    // ── 拉数据 ──────────────────────────────────────────────────────────
    private void loadAll() {
        final String token = getSharedPreferences(PREFS, MODE_PRIVATE).getString("accountToken", "");
        if (token == null || token.isEmpty()) return;
        new Thread(() -> {
            JSONObject libs = null;
            JSONObject mine = null;
            String failure = "";
            try {
                libs = client.orgLibraries();
                mine = client.orgMyRequests();
            } catch (Exception error) {
                failure = error.getMessage() == null ? error.toString() : error.getMessage();
            }
            final JSONObject libBody = libs;
            final JSONObject mineBody = mine;
            final String error = failure;
            ui.post(() -> {
                if (error != null && !error.isEmpty()) {
                    hint.setText(getString(R.string.terms_load_failed, ServerText.of(this, error)));
                }
                renderLibraries(libBody);
                renderRequests(mineBody);
            });
        }, "terms-lib-load").start();
    }

    private void renderLibraries(JSONObject body) {
        libList.removeAllViews();
        JSONArray libraries = body == null ? null : body.optJSONArray("libraries");
        if (libraries == null || libraries.length() == 0) {
            hint.setText(getString(R.string.terms_lib_empty));
            return;
        }
        hint.setText(getString(R.string.terms_lib_hint));
        for (int i = 0; i < libraries.length(); i++) {
            JSONObject one = libraries.optJSONObject(i);
            if (one == null) continue;
            libList.addView(libraryRow(one));
        }
    }

    private View libraryRow(final JSONObject library) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setBackgroundResource(R.drawable.bg_card);
        int pad = dp(16);
        card.setPadding(pad, pad, pad, pad);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        params.bottomMargin = dp(8);
        card.setLayoutParams(params);

        TextView title = new TextView(this);
        title.setText(library.optString("name", library.optString("id", "")));
        title.setTextColor(getColor(R.color.ink));
        title.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 17);
        title.setTypeface(null, android.graphics.Typeface.BOLD);
        card.addView(title);

        TextView meta = new TextView(this);
        String category = library.optString("categoryName", "");
        String count = getString(R.string.terms_lib_row, String.valueOf(library.optInt("entries", 0)));
        meta.setText(category.isEmpty() ? count : (category + " · " + count));
        meta.setTextColor(getColor(R.color.ink_soft));
        meta.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 12);
        LinearLayout.LayoutParams metaParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        metaParams.topMargin = dp(6);
        meta.setLayoutParams(metaParams);
        card.addView(meta);

        Button apply = new Button(this);
        apply.setText(getString(R.string.terms_apply));
        apply.setAllCaps(false);
        apply.setBackgroundResource(R.drawable.tap_btn_secondary);
        apply.setTextColor(getColor(R.color.brand));
        LinearLayout.LayoutParams applyParams = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(44));
        applyParams.topMargin = dp(12);
        apply.setLayoutParams(applyParams);
        apply.setOnClickListener(v -> pickRequestType(library));
        card.addView(apply);
        return card;
    }

    private void renderRequests(JSONObject body) {
        requestList.removeAllViews();
        JSONArray requests = body == null ? null : body.optJSONArray("requests");
        if (requests == null || requests.length() == 0) {
            TextView empty = new TextView(this);
            empty.setText(getString(R.string.terms_requests_empty));
            empty.setTextColor(getColor(R.color.ink_faint));
            empty.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 12);
            requestList.addView(empty);
            return;
        }
        for (int i = requests.length() - 1; i >= 0; i--) {     // 新的在前
            JSONObject one = requests.optJSONObject(i);
            if (one == null) continue;
            requestList.addView(requestRow(one));
        }
    }

    private View requestRow(final JSONObject request) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setBackgroundResource(R.drawable.bg_card);
        int pad = dp(16);
        card.setPadding(pad, pad, pad, pad);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        params.bottomMargin = dp(8);
        card.setLayoutParams(params);

        String type = request.optString("type", "");
        String status = request.optString("status", "pending");
        TextView title = new TextView(this);
        title.setText(kindLabel(type) + " · " + entryText(request) + " · " + statusLabel(status));
        title.setTextColor(getColor("approved".equals(status) ? R.color.ok
                : ("rejected".equals(status) ? R.color.err : R.color.ink)));
        title.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 14);
        card.addView(title);

        String reason = request.optString("reason", "");
        if (!reason.isEmpty()) {
            TextView line = new TextView(this);
            line.setText(reason);
            line.setTextColor(getColor(R.color.ink_soft));
            line.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 12);
            LinearLayout.LayoutParams lineParams = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            lineParams.topMargin = dp(6);
            line.setLayoutParams(lineParams);
            card.addView(line);
        }

        if ("pending".equals(status)) {
            Button withdraw = new Button(this);
            withdraw.setText(getString(R.string.terms_withdraw));
            withdraw.setAllCaps(false);
            withdraw.setBackgroundResource(R.drawable.tap_btn_secondary);
            withdraw.setTextColor(getColor(R.color.ink_soft));
            LinearLayout.LayoutParams withdrawParams = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT, dp(40));
            withdrawParams.topMargin = dp(10);
            withdraw.setLayoutParams(withdrawParams);
            withdraw.setOnClickListener(v -> withdraw(request.optString("id", "")));
            card.addView(withdraw);
        }
        return card;
    }

    private String kindLabel(String type) {
        if ("add".equals(type)) return getString(R.string.terms_kind_add);
        if ("update".equals(type)) return getString(R.string.terms_kind_update);
        return getString(R.string.terms_kind_delete);
    }

    private String statusLabel(String status) {
        if ("approved".equals(status)) return getString(R.string.terms_status_approved);
        if ("rejected".equals(status)) return getString(R.string.terms_status_rejected);
        if ("withdrawn".equals(status)) return getString(R.string.terms_status_withdrawn);
        return getString(R.string.terms_status_pending);
    }

    /** 申请里那条术语长什么样：删除只有 targetKey，新增/修改是 entry.zh。 */
    private String entryText(JSONObject request) {
        JSONObject entry = request.optJSONObject("entry");
        if (entry != null) return entry.optString("zh", "");
        return request.optString("targetKey", "");
    }

    // ── 提申请 ──────────────────────────────────────────────────────────
    private void pickRequestType(final JSONObject library) {
        final String[] types = {"add", "update", "delete"};
        final String[] labels = {getString(R.string.terms_req_add),
                getString(R.string.terms_req_update), getString(R.string.terms_req_delete)};
        new android.app.AlertDialog.Builder(this)
                .setTitle(R.string.terms_req_pick)
                .setItems(labels, (dialog, which) -> showRequestForm(library, types[which]))
                .setNegativeButton(R.string.common_cancel, null)
                .show();
    }

    private void showRequestForm(final JSONObject library, final String type) {
        View form = getLayoutInflater().inflate(R.layout.dialog_term_request, null);
        TextView libLine = form.findViewById(R.id.reqLibLine);
        final EditText zhInput = form.findViewById(R.id.reqZh);
        final EditText ptInput = form.findViewById(R.id.reqPt);
        final EditText reasonInput = form.findViewById(R.id.reqReason);

        String libName = library.optString("name", library.optString("id", ""));
        libLine.setText(libName + " · " + kindLabel(type));
        // 删除只要中文（要删的那条），新增/修改两个都要
        boolean needPt = !"delete".equals(type);
        ptInput.setVisibility(needPt ? View.VISIBLE : View.GONE);

        new android.app.AlertDialog.Builder(this)
                .setTitle(getString(R.string.terms_req_form_title, libName, kindLabel(type)))
                .setView(form)
                .setNegativeButton(R.string.common_cancel, null)
                .setPositiveButton(R.string.terms_req_submit, (dialog, which) -> {
                    String zh = zhInput.getText().toString().trim();
                    String pt = ptInput.getText().toString().trim();
                    String reason = reasonInput.getText().toString().trim();
                    if (zh.isEmpty()) {
                        Toast.makeText(this, getString(R.string.terms_req_need_zh), Toast.LENGTH_SHORT).show();
                        return;
                    }
                    if (needPt && pt.isEmpty()) {
                        Toast.makeText(this, getString(R.string.terms_req_need_pt), Toast.LENGTH_SHORT).show();
                        return;
                    }
                    submit(library.optString("id", ""), type, zh, pt, reason);
                })
                .show();
    }

    private void submit(final String libraryId, final String type, final String zh,
                        final String pt, final String reason) {
        new Thread(() -> {
            String failure = "";
            try {
                JSONObject body = new JSONObject();
                body.put("type", type);
                body.put("libraryId", libraryId);
                // ⚠️ applicant 不放进去：服务端从 token 解，放了也会被忽略
                if (!"delete".equals(type)) {
                    body.put("zh", zh);
                    body.put("pt", pt);
                } else {
                    body.put("zh", zh);
                }
                body.put("reason", reason);
                JSONObject result = client.orgCreateRequest(body);
                if (result == null || !result.optBoolean("ok", false)) {
                    failure = ServerText.from(this, result, "");
                }
            } catch (Exception error) {
                failure = error.getMessage() == null ? error.toString() : error.getMessage();
            }
            final String failed = failure;
            ui.post(() -> {
                if (failed.isEmpty()) {
                    Toast.makeText(this, getString(R.string.terms_req_sent), Toast.LENGTH_LONG).show();
                    loadAll();
                } else {
                    Toast.makeText(this, getString(R.string.terms_req_failed, ServerText.of(this, failed)),
                            Toast.LENGTH_LONG).show();
                }
            });
        }, "terms-req-submit").start();
    }

    private void withdraw(final String requestId) {
        new Thread(() -> {
            String failure = "";
            try {
                JSONObject result = client.orgWithdrawRequest(requestId);
                if (result == null || !result.optBoolean("ok", false)) {
                    failure = ServerText.from(this, result, "");
                }
            } catch (Exception error) {
                failure = error.getMessage() == null ? error.toString() : error.getMessage();
            }
            final String failed = failure;
            ui.post(() -> {
                if (failed.isEmpty()) {
                    Toast.makeText(this, getString(R.string.terms_withdrawn_ok), Toast.LENGTH_SHORT).show();
                    loadAll();
                } else {
                    Toast.makeText(this,
                            getString(R.string.terms_withdraw_failed, ServerText.of(this, failed)),
                            Toast.LENGTH_LONG).show();
                }
            });
        }, "terms-req-withdraw").start();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
