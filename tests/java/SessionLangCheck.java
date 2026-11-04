import com.leion.lanrelay.SessionLang;

/**
 * SessionLangCheck —— 「这一场到底用哪个识别语种」的可执行验证（5.64）
 * ============================================================================
 *
 * 这条判据写错的表现极其安静：界面一切正常、字幕照常出（只是跑的模型不是用户选的），
 * 唯一证据是服务器上那份 `asr-profiles/<房间>.json` 里的键写成了另一个语言。
 * 实机就是这么踩到的 —— 侧车写 `zh-CN`、识别按 `en-US` 跑，匹配不上，日志里一直 large-v3。
 *
 * 所以这里钉四件事：
 *   ① `start(lang)` 给的语种**优先**（这是唯一可靠的"这一场要识别什么"）；
 *   ② 它空着才退回实例自带字段（历史行为不被打断）；
 *   ③ 归一化：大小写、下划线、带空格都要折成侧车/识别侧认的标签；
 *   ④ 两个都空 → 空串（不许猜成某个语言 —— 猜错比不补更糟）。
 *
 * 只依赖纯 Java（SessionLang 不 import android）。输出刻意 ASCII。
 */
public final class SessionLangCheck {

    private static int passed = 0;
    private static int failed = 0;

    private static void check(String label, boolean ok, String detail) {
        if (ok) {
            passed += 1;
            return;
        }
        failed += 1;
        System.out.println("FAIL: " + label + (detail.isEmpty() ? "" : "  [" + detail + "]"));
    }

    private static void check(String label, boolean ok) {
        check(label, ok, "");
    }

    public static void main(String[] args) {
        // ① 路由器给的语种优先（实测 bug 的修法就是这个）
        check("start 给的英语胜过实例自带的中文",
                "en-us".equals(SessionLang.choose("en-US", "zh-CN")),
                SessionLang.choose("en-US", "zh-CN"));
        check("反过来也一样（不是只认某一个方向）",
                "zh-cn".equals(SessionLang.choose("zh-CN", "en-US")),
                SessionLang.choose("zh-CN", "en-US"));

        // ② 只给实例自带值时才退回它
        check("start 空着 -> 用实例自带",
                "pt-br".equals(SessionLang.choose("", "pt-BR")), SessionLang.choose("", "pt-BR"));
        check("start 是 null 也走同一条路",
                "pt-br".equals(SessionLang.choose(null, "pt-BR")), SessionLang.choose(null, "pt-BR"));
        check("start 是纯空白也走同一条路",
                "pt-br".equals(SessionLang.choose("   ", "pt-BR")), SessionLang.choose("   ", "pt-BR"));

        // ③ 归一化：侧车键与识别侧必须是同一套标签
        check("大小写与下划线都归一（PT_br -> pt-br）",
                "pt-br".equals(SessionLang.sidecarKey("PT_br", "")), SessionLang.sidecarKey("PT_br", ""));
        check("前后空格去掉", "en-us".equals(SessionLang.sidecarKey(" en-US ", "")));

        // ④ 两个都空：空串，不猜
        check("两个都空 -> 空串（不猜成任何一个语言）",
                SessionLang.choose("", "").isEmpty() && SessionLang.choose(null, null).isEmpty());
        check("sidecarKey 与 choose 是同一套规则（不许两处各写一份）",
                SessionLang.sidecarKey("en-US", "zh-CN").equals(SessionLang.choose("en-US", "zh-CN")));

        System.out.println("passed=" + passed + " failed=" + failed);
        if (failed > 0) System.exit(1);
    }
}
