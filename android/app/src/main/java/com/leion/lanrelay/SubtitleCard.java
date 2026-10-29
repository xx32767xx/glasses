package com.leion.lanrelay;

import android.content.Context;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;

import org.json.JSONObject;

/**
 * 渲染一张字幕卡（4.72）。
 *
 * <p>会议室里的字幕卡是 {@link RoomActivity} 用代码搭的（那张卡要支持"同一句三帧原地更新"）。
 * 历史详情里的转写全文需要**同样的外观**，于是这里把外观落成 {@code item_subtitle_card.xml}
 * 并集中在这一处渲染。两个地方共用同一套 drawable / 字号 / 内边距 ——
 * {@code android-order-suite} 里有断言盯着"两边一致"，改一处忘另一处会红。
 */
public final class SubtitleCard {

    private SubtitleCard() {
    }

    /**
     * @param parent   要挂进去的容器（用来拿 LayoutInflater 与 size）
     * @param line     一条转写记录：{username, srcText, dstText, mine, final}
     * @param mineName 当前用户名（用来判断是不是自己说的，以及头像取哪个字）
     */
    public static View render(ViewGroup parent, JSONObject line, String mineName) {
        Context ctx = parent.getContext();
        View card = LayoutInflater.from(ctx).inflate(R.layout.item_subtitle_card, parent, false);

        String speaker = line.optString("username", "");
        boolean mine = mineName != null && !mineName.isEmpty() && mineName.equals(speaker);
        if (mine) {
            card.setBackgroundResource(R.drawable.bg_subtitle_self);
        }

        TextView avatar = card.findViewById(R.id.subAvatar);
        TextView name = card.findViewById(R.id.subSpeaker);
        TextView langTag = card.findViewById(R.id.subLangTag);
        TextView state = card.findViewById(R.id.subState);
        TextView original = card.findViewById(R.id.subOriginal);
        TextView target = card.findViewById(R.id.subTarget);

        avatar.setText(mine ? ctx.getString(R.string.room_me_my) : firstChar(speaker));
        name.setText(speaker);
        langTag.setText(mine ? ctx.getString(R.string.room_i_said) : ctx.getString(R.string.room_other));
        boolean partial = line.optBoolean("final", true) == false;
        state.setText(partial ? ctx.getString(R.string.st_recognizing) : ctx.getString(R.string.st_done));
        state.setTextColor(ctx.getColor(partial ? R.color.accent : R.color.ok));

        String srcText = line.optString("srcText", "");
        String dstText = line.optString("dstText", "");
        // 与会议室一致：原文是可选项（用户关掉「原文」时它不显示）
        original.setText(srcText);
        original.setVisibility(srcText.isEmpty() ? View.GONE : View.VISIBLE);
        target.setText(dstText);
        return card;
    }

    private static String firstChar(String raw) {
        if (raw == null || raw.isEmpty()) return "?";
        return raw.substring(0, 1).toUpperCase(java.util.Locale.ROOT);
    }
}
