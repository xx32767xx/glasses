package com.leion.lanrelay;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * 涓庣數鑴戜笂鐨勫眬鍩熺綉杞彂杩涚▼閫氫俊銆?
 *
 * 鍙仛浜斾欢浜嬶紝鍜?relay/lan-relay.mjs 鐨勪簲涓鐐逛竴涓€瀵瑰簲锛?
 *   hello()      鎻℃墜锛氶獙璇佸叡浜瘑閽?+ 鍙栧洖鏄剧ず棰勭畻锛坈ols / lineBudget锛?
 *   闀胯疆璇㈠惊鐜?    /frame?since=&lt;seq&gt;锛氭湁鏂板瓧骞曞氨鍥炶皟锛涙病鏈夊氨鎸備綇绛?
 *   sendText()   鎶婅瘑鍒嚭鐨勬枃瀛?POST 缁?/say锛堝紓姝ワ紝涓嶉樆濉炵晫闈級
 *   sendAudio()  鎶婁竴娈靛綍闊?POST 缁?/audio锛?*鍚屾**锛岃涓嬮潰鐨勮鏄庯級
 *   status()     /status锛岃瘖鏂敤
 *
 * 涓轰粈涔?sendAudio 鏄悓姝ョ殑銆佽€?sendText 鏄紓姝ョ殑锛?
 *   sendText 鏄敤鎴风偣涓€涓嬪彂涓€鍙ワ紝寮傛鍗冲彲銆傝€屽綍闊充笂浼犳槸姣忕涓€鍧椼€佽繛缁笉鏂紝
 *   濡傛灉姣忓潡閮芥柊璧蜂竴涓嚎绋嬶紝缃戠粶涓€鎱㈠氨浼氬爢鍑哄嚑鍗佷釜绾跨▼浜掔浉鎶㈠甫瀹姐€?
 *   鎵€浠ュ綍闊抽偅鏉¤矾鐢辫皟鐢ㄦ柟锛圡icUploader锛夊湪鑷繁鐨勫悗鍙扮嚎绋嬮噷**闃诲**璋冪敤锛?
 *   澶╃劧褰㈡垚鑳屽帇锛氫笂浼犺窡涓嶄笂灏卞皯璇讳竴鐐归煶棰戯紝鑰屼笉鏄棤闄愬埗鍦板爢绾跨▼銆?
 *   鐣岄潰绾跨▼缁濆涓嶈兘鐩存帴璋冨畠銆?
 *
 * 涓轰粈涔堢敤闀胯疆璇㈣€屼笉鏄?WebSocket锛氬畨鍗撹繖杈瑰彧闇€瑕佷竴涓櫘閫?HTTP GET 寰幆锛?
 * 涓嶇敤寮曚换浣曠涓夋柟搴擄紝涔熶笉鐢ㄥ鐞?WebSocket 鎻℃墜涓庨噸杩炪€傚瓧骞曟湰鏉ュ氨鏄綆棰戜簨浠讹紝
 * 闀胯疆璇㈠湪娌℃湁鏂板抚鏃舵槸鎸備綇鐨勶紝涓嶄細绌鸿浆銆?
 *
 * 娉ㄦ剰锛氭墍鏈夊洖璋冮兘鍙戠敓鍦?*鍚庡彴绾跨▼**涓婏紝璋冪敤鏂癸紙Activity锛夊繀椤昏嚜宸卞垏鍥炰富绾跨▼銆?
 */
public class LanClient {

    /** 鍥炶皟鎺ュ彛銆傚疄鐜版柟璐熻矗鍒囧洖涓荤嚎绋嬨€?*/
    /** 浼氳瘽澶辨晥锛?01锛夛細閫氬父鏄?鍚屼竴璐﹀彿鍦ㄥ埆澶勭櫥褰?鎶婃垜鐨?token 韪㈡帀浜嗐€?*/
    public static class SessionExpiredException extends IOException {
        public SessionExpiredException(String message) {
            super(message == null || message.isEmpty() ? "鐧诲綍宸插け鏁堬紝璇烽噸鏂扮櫥褰? : message);
        }
    }

    public interface Listener {
        /** 涓€鏉′汉绫诲彲璇荤殑鐘舵€?杩涘害淇℃伅銆?*/
        void onStatus(String message);

        /** 鎻℃墜鎴愬姛锛氭嬁鍒颁簡璁惧鍚嶄笌鏄剧ず棰勭畻銆?*/
        void onHello(String device, int cols, int lineBudget);

        /**
         * 鏀跺埌涓€甯ф柊瀛楀箷銆?
         *
         * @param text       缁欎僵鎴磋€呯湅鐨勯偅涓€渚э紙宸茬炕璇戝ソ锛夛紱lines 鏄畠鎸夋樉绀洪绠楁姌濂界殑琛?
         * @param source     鍘熸枃锛堝鏂硅鐨勮瘽锛屾垨浣╂埓鑰呰嚜宸辫鐨勮瘽锛夛紱娌℃湁灏辨槸绌轰覆
         * @param sourceLang 鍘熸枃璇锛涙湭鐭ユ槸 "unknown"
         * @param partial    true = 杩欎竴甯ц繕鏄祦寮忓閲忥紙鐣岄潰瑕佹墦銆岀敓鎴愪腑銆嶅苟**鍘熶綅鏇存柊**锛?
         * @param termsMissing 鏈彞"鎻愬埌浜嗚〃鍐呭悕瀛椼€佷絾璇戞枃娌″啓鍑鸿鑼冨啓娉?鐨勪腑鏂囧悕鍒楄〃锛?
         *                     绌烘暟缁?= 娌℃湁锛坉ocs/15 搂17锛屽彧鎻愮ず銆佷笉鏀瑰瓧骞曪級
         *
         * 涓轰粈涔?source 鍜?partial 閮借锛氱晫闈㈡寜"鍘熸枃鍦ㄤ笂銆佽瘧鏂囧湪涓?鎴愬鏄剧ず锛?
         * 骞朵笖瑕佹妸"澧為噺 鈫?瀹氱 鈫?鏍″淇"钀藉埌**鍚屼竴鏉?*鐗囨涓娿€?
         * 灏戜簡杩欎袱涓瓧娈碉紝鎵嬫満鍙兘闈犵寽锛堢寽閿欑殑琛ㄧ幇鏄瓧骞曟案杩滄寕鐫€銆岀敓鎴愪腑銆嶏級銆?
         */
        void onFrame(String speaker, String lang, String[] lines, String text,
                     String source, String sourceLang, boolean partial, String[] termsMissing);

        /** 鍑洪敊浜嗭紙缃戠粶涓嶉€氥€佸瘑閽ラ敊銆佽鎷掔粷绛夛級銆?*/
        void onError(String message);
    }

    private final String baseUrl;
    private final String secret;
    private final Listener listener;

    private volatile boolean running = false;
    private Thread pollThread;
    private long seq = 0;
    /**
     * 鐑瘝琛ㄧ殑鐢ㄦ埛鍚嶏紙docs/15 搂8.3锛夈€傛彙鎵嬫椂闅?`/hello?user=` 鎶ョ粰鐢佃剳锛?
     * 鐢佃剳鎹鍐冲畾"涓嬩竴鍦哄悓浼犺鍝紶琛?銆傜┖ 鈫?鐢佃剳渚у洖钀?`default`銆?
     */
    private volatile String user = "";
    /**
     * 璐︽埛 token锛堢櫥褰?娉ㄥ唽鍚庢嬁鍒帮級銆傚畠鐨勭敤閫斿彧鏈変竴涓細璇存槑"鎴戞槸璋?銆?
     *
     * <p>涓轰粈涔堜笉鍐嶇敤鐢ㄦ埛鍚嶅綋韬唤锛氬師鏉ュ鎴风鑷姤 `user=wu`銆佹湇鍔＄灏变俊 鈥斺€?
     * 鏀逛竴涓弬鏁板氨鑳借鍐欏埆浜虹殑琛ㄣ€傜幇鍦ㄦ湇鍔＄鍙 token锛岀敤鎴峰悕鍙槸 token 鐨勫睘鎬с€?
     */
    private volatile String token = "";

    public void setUser(String value) {
        this.user = value == null ? "" : value.trim();
    }

    /** 褰撳墠鏈嶅姟鍣ㄥ湴鍧€锛堢敤浜?鍦板潃鏀逛簡瑕侀噸寤哄鎴风"鐨勫垽鏂級銆?*/
    public String getBaseUrl() {
        return baseUrl;
    }

    /** 褰撳墠鍏变韩瀵嗛挜锛堝悓涓婏級銆?*/
    public String getSecret() {
        return secret;
    }
    public void setToken(String value) {
        this.token = value == null ? "" : value.trim();
    }

    public String getToken() {
        return token;
    }

    public LanClient(String baseUrl, String secret, Listener listener) {
        String trimmed = baseUrl == null ? "" : baseUrl.trim();
        while (trimmed.endsWith("/")) {
            trimmed = trimmed.substring(0, trimmed.length() - 1);
        }
        this.baseUrl = trimmed;
        this.secret = secret == null ? "" : secret.trim();
        this.listener = listener;
    }

    public void start() {
        if (running) {
            return;
        }
        running = true;
        pollThread = new Thread(this::pollLoop, "lan-poll");
        pollThread.setDaemon(true);
        pollThread.start();
    }

    public void stop() {
        running = false;
        if (pollThread != null) {
            pollThread.interrupt();
            pollThread = null;
        }
    }

    public boolean isRunning() {
        return running;
    }

    /** 鎶婃墜鍐?璇嗗埆鍑虹殑涓€鍙ヨ瘽浜ょ粰鐢佃剳銆傛暣涓繃绋嬪湪鍚庡彴绾跨▼閲屽仛锛岀晫闈笉浼氬崱銆?*/
    public void sendText(final String text, final String from) {
        if (text == null || text.trim().isEmpty()) {
            return;
        }
        Thread thread = new Thread(() -> {
            try {
                JSONObject body = new JSONObject();
                body.put("text", text.trim());
                if (from != null && !from.isEmpty()) {
                    body.put("from", from);
                }
                JSONObject response = request("/say", "POST", body, 8000);
                listener.onStatus("宸查€佸埌鐢佃剳锛? + text.trim()
                        + "锛堟敹浠剁绗?" + response.optInt("inboxLines", 0) + " 琛岋級");
            } catch (Exception error) {
                listener.onError("鍙戦€佸け璐ワ細" + describe(error));
            }
        }, "lan-say");
        thread.setDaemon(true);
        thread.start();
    }

    /**
     * 涓婁紶涓€鍧楀綍闊筹紙**鍚屾**锛屽繀椤诲湪鍚庡彴绾跨▼閲岃皟锛夈€?
     *
     * @param pcm        瑁?PCM锛?6-bit 灏忕銆佸崟澹伴亾
     * @param sampleRate 閲囨牱鐜囥€傚畨鍗撲笉淇濊瘉閮借兘鐢?16 kHz锛屾墍浠ュ瀹炰笂鎶ワ紝
     *                   鐢佃剳渚х殑璇嗗埆杩涚▼浼氭寜杩欎釜鏁板瓧閲嶉噰鏍凤紙鐚滈敊浼氳璇嗗埆鍏ㄤ贡锛?
     * @param fresh      true = 杩欐槸涓€娆℃柊褰曢煶鐨勭涓€鍧楋紝璁╃户鐢靛櫒鍏堟妸鏃ч煶棰戞竻鎺?
     * @param lang       褰撳墠鍦ㄥ惉鍝璇█锛坺h-CN / pt-BR锛夈€傛瘡鍧楅兘鍙戯紝
     *                   鎵€浠ュ綍闊充腑鍒囨崲璇涓嬩竴鍙ュ氨鐢熸晥
     * @return 缁х數鍣ㄧ殑鍥炴墽锛屽惈绱绉掓暟锛堢晫闈㈢敤瀹冩樉绀?宸蹭笂浼犲涔?锛?
     */
    public JSONObject sendAudio(byte[] pcm, int sampleRate, boolean fresh, String lang)
            throws IOException, org.json.JSONException {
        StringBuilder path = new StringBuilder("/audio?rate=").append(sampleRate);
        if (fresh) {
            path.append("&fresh=1");
        }
        if (lang != null && !lang.isEmpty()) {
            path.append("&lang=").append(lang);
        }
        return requestRaw(path.toString(), pcm, 10000);
    }

    /**
     * 鍚屾璇讳竴娆?/status锛岃繑鍥炲師濮?JSON锛?*瑕佸湪鍚庡彴绾跨▼璋?*锛夈€?
     *
     * 涓轰粈涔堥渶瑕佸畠銆佽€屼笉鍙槸 fetchStatus() 閭ｆ潯鏂囧瓧锛?
     * 鐣岄潰蹇呴』鍖哄垎"杩炰笂浜嗙數鑴?鍜?鍚屼紶鏈嶅姟鐪熺殑鍦ㄥ伐浣?銆傝繖涓嶆槸闈犵寽 鈥斺€?
     * /status 閲屾湁鐪熷疄璇佹嵁锛?
     *   路 busSeen    缁х數鍣ㄦ湁娌℃湁瑙佽繃瀛楀箷鎬荤嚎锛? 澶ц剳鑷冲皯浜у嚭杩囦竴甯у瓧骞曪級
     *   路 inboxLines 鏀朵欢绠遍噷宸茬粡鏈夊嚑琛岋紙= 璇嗗埆閭ｄ竴渚у湪鍐欎笢瑗匡級
     * 涓や釜閮芥槸 0 璇存槑"绠￠亾閫氫簡浣嗚繕娌℃祦杩囨按"锛屾鏃惰"鏈嶅姟鍙敤"鏄繃搴︽壙璇恒€?
     */
    public JSONObject status() throws IOException, org.json.JSONException {
        return request("/status", "GET", null, 8000);
    }

    /**
     * 鎶婁竴琛?鎴戣繖杈瑰疄闄呭仛浜嗕粈涔?鍥炰紶缁欑數鑴戯紝鎵撹繘鍚屼竴浠芥棩蹇椼€?
     *
     * <p><b>涓轰粈涔堥渶瑕佸畠</b>锛氭湁浜涢棶棰?*鍙湁鎶婁袱杈瑰苟鎺掓斁鎵嶈兘瀹氫綅**銆?
     * 姣斿"鐪奸暅涓婃樉绀?Ol鈥?锛氱數鑴戠鏃ュ織鑳借瘉鏄庡畠**鍙戜簡**瀹氱甯э紝
     * 浣嗘墜鏈烘敹鍒颁箣鍚庢湁娌℃湁**搴旂敤**銆佸簲鐢ㄦ垚浜嗕粈涔堬紝浠庣數鑴戦偅杈瑰畬鍏ㄧ湅涓嶈 鈥斺€?
     * 涓よ竟鍚勮嚜鐪嬮兘"姝ｅ父"锛屽悎璧锋潵鎵嶆槸闂銆?
     *
     * <p><b>鍒绘剰鍋氭垚 fire-and-forget</b>锛氬湪鐙珛绾跨▼閲屽彂銆佸け璐?*闈欓粯蹇界暐**銆?
     * 璇婃柇閫氶亾鍧忔帀缁濅笉鑳藉奖鍝嶅悓浼犳湰韬?鈥斺€?瀹冩槸涓轰簡鏌ラ棶棰橈紝涓嶆槸涓轰簡鍒堕€犻棶棰樸€?
     */
    public void sendDiag(String line) {
        if (line == null || line.isEmpty()) return;
        final String baseUrl = this.baseUrl;
        final String secret = this.secret;
        Thread thread = new Thread(() -> {
            try {
                JSONObject body = new JSONObject();
                body.put("line", line);
                request("/diag", "POST", body, 4000);
            } catch (Throwable ignored) {
                // 璇婃柇澶辫触灏卞け璐ワ細涓嶆姤閿欍€佷笉褰卞搷涓绘祦绋?
            }
        }, "diag-send");
        thread.setDaemon(true);
        thread.start();
    }

    /** 璇婃柇锛氭妸 /status 鐨勮鏁拌鍥炴潵銆?*/
    public void fetchStatus() {        Thread thread = new Thread(() -> {            try {
                JSONObject json = request("/status", "GET", null, 8000);
                listener.onStatus("鐢佃剳渚э細瀛楀箷 " + json.optInt("frames", 0)
                        + " 甯?/ 鏀跺埌 " + json.optInt("says", 0)
                        + " 鍙?/ 鏀朵欢绠?" + json.optInt("inboxLines", 0)
                        + " 琛岋紙鎷掔粷 " + json.optInt("rejected", 0) + " 娆★級");
            } catch (Exception error) {
                listener.onError("鍙栫姸鎬佸け璐ワ細" + describe(error));
            }
        }, "lan-status");
        thread.setDaemon(true);
        thread.start();
    }

    // 鈹€鈹€ 璐︽埛锛堟敞鍐?/ 鐧诲綍 / 娉ㄩ攢 / 鎴戞槸璋侊級鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

    /** 娉ㄥ唽璐︽埛锛屾垚鍔熷悗鎷?token锛堜互鍚庢墍鏈夎姹傜殑韬唤鍑嵁锛夈€?*/
    public JSONObject authRegister(String username, String password)
            throws IOException, org.json.JSONException {
        JSONObject body = new JSONObject();
        body.put("username", username);
        body.put("password", password);
        body.put("label", "android");
        return requestWithCode("/auth/register", "POST", body, 12000);
    }

    /** 鐧诲綍锛堟湇鍔＄鍒绘剰涓嶅尯鍒?鐢ㄦ埛涓嶅瓨鍦?涓?瀵嗙爜閿?锛夈€?*/
    public JSONObject authLogin(String username, String password)
            throws IOException, org.json.JSONException {
        JSONObject body = new JSONObject();
        body.put("username", username);
        body.put("password", password);
        body.put("label", "android");
        return requestWithCode("/auth/login", "POST", body, 12000);
    }

    /** 娉ㄩ攢褰撳墠 token锛堝埆鐨勮澶囦笉鍙楀奖鍝嶏級銆?*/
    public JSONObject authLogout() throws IOException, org.json.JSONException {
        return requestWithCode("/auth/logout", "POST", null, 8000);
    }

    /** 鐢ㄥ綋鍓?token 闂?鎴戞槸璋?锛堝け鏁堟椂 401锛夈€?*/
    public JSONObject authWhoAmI() throws IOException, org.json.JSONException {
        return requestWithCode("/auth/whoami", "GET", null, 8000);
    }

    // 鈹€鈹€ 鐑瘝瀵圭収琛紙docs/15 闃舵 1锛氬彧鏍￠獙涓庡瓨鍙栵紝涓嶅仛鏇挎崲锛夆攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

    /**
     * 棰勬牎楠岋細鍙鐢佃剳鍒や竴閬嶏紝**涓嶄繚瀛?*銆傜晫闈笂鍙互鍙嶅鐐广€?
     *
     * <p>鏍￠獙鍦ㄧ數鑴戠鍋氾紙`POST /terms/validate`锛夛紝鎵嬫満涓嶈嚜宸卞垽 鈥斺€?
     * 鍚﹀垯浼氬嚭鐜?鎵嬫満涓婇€氳繃銆佺湡涓婁紶琚嫆"杩欑鏈€闅捐В閲婄殑鎯呭喌銆?
     *
     * @return `{ code, json }`锛沗json.ok` 涓?true 琛ㄧず鍏ㄩ儴鍚堟硶
     */
    public JSONObject termsValidate(org.json.JSONArray entries)
            throws IOException, org.json.JSONException {
        JSONObject body = new JSONObject();
        body.put("entries", entries);
        return requestWithCode("/terms/validate", "POST", body, 8000);
    }

    /**
     * 涓婁紶锛?*鍏ㄥ悎娉曟墠鏁磋〃鏇挎崲**锛堜竴鏉′笉鍚堟硶灏辨暣琛ㄤ笉瀛橈紝杩斿洖 400 + 閫愭潯鍘熷洜锛夈€?
     * @return `{ code, json }`
     */
    public JSONObject termsPut(org.json.JSONArray entries)
            throws IOException, org.json.JSONException {
        JSONObject body = new JSONObject();
        body.put("entries", entries);
        return requestWithCode("/terms", "PUT", body, 12000);
    }

    /** 鍙栫數鑴戜笂褰撳墠鐢熸晥鐨勯偅寮犺〃锛堢敤鏉ュ洖濉紪杈戞锛夈€?*/
    public JSONObject termsGet() throws IOException, org.json.JSONException {
        return requestWithCode("/terms", "GET", null, 8000);
    }

    // 鈹€鈹€ 缁勭粐鎺ュ彛锛氬簱 / 浼氳閫夊簱 / 鐢宠瀹℃壒锛坉ocs/19锛夆攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    //
    // 涓庢棫鐑瘝琛ㄦ帴鍙ｇ殑鍖哄埆锛堝緢鍏抽敭锛屽埆娣风敤锛夛細
    //   路 鏃?`/terms` 鏄?鐢ㄦ埛鑷繁鏀硅嚜宸遍偅寮犺〃"锛屾柊 `/org/*` 鏄?鐢ㄦ埛鍙兘閫夊簱涓庢彁鐢宠"锛?
    //   路 鍏ㄩ儴璧?requestWithCode锛氭潈闄愭嫆缁濓紙403锛変笌涓氬姟鎷掔粷锛?00锛夐兘瑕佽兘璇诲嚭鎻愮ず鏂囨銆?
    //
    // 鈿狅笍 **蹇呴』鎷嗗寘**锛歳equestWithCode 杩斿洖鐨勬槸 `{code, json}` 鍖呰瀵硅薄锛堟棫鐨勭儹璇嶈〃鎺ュ彛
    //    灏辨槸杩欎箞鐢ㄧ殑锛夛紝涓嶆槸鍝嶅簲姝ｆ枃銆傜涓€鐗堣繖閲岀洿鎺ユ妸瀹冨綋鎴愭鏂囩敤浜?鈥斺€?
    //    浜庢槸 `optBoolean("ok")` 姘歌繙 false銆乣optString("error")` 姘歌繙鍙栦笉鍒帮紝
    //    鐣岄潰鍙兘鏄剧ず"璇诲彇搴撳け璐ワ細鏈煡鍘熷洜"銆傝俯杩囦竴娆★紝鍒啀鏉ャ€?
    private static JSONObject unwrap(JSONObject wrapper) {
        JSONObject json = wrapper == null ? null : wrapper.optJSONObject("json");
        if (json == null) json = new JSONObject();
        if (!json.has("error") && wrapper != null && wrapper.optInt("code", 0) > 0) {
            // 鎶?HTTP 鐮佸鍥炲幓锛氱晫闈㈣兘鐩存帴鏄剧ず"锛圚TTP 404锛?锛岀渷鎺変竴杞寽
            try {
                json.put("httpStatus", wrapper.optInt("code", 0));
            } catch (org.json.JSONException ignored) {
                // 鏀句笉杩涘幓灏辨斁涓嶈繘锛屼笉褰卞搷涓绘祦绋?
            }
        }
        return json;
    }

    /** 鍒楀嚭鏈満鍙敤搴擄紙admin/user/dev 閮借兘璇伙級銆?*/
    public JSONObject orgLibraries() throws IOException, org.json.JSONException {
        return unwrap(requestWithCode("/org/libraries", "GET", null, 8000));
    }

    /** 鍗曚釜搴撶殑璇︽儏锛?*鍚潯鐩鏂?*锛岀敤浜?鐐瑰紑鐪嬮噷闈㈡湁浠€涔?锛夈€?*/
    public JSONObject orgLibrary(String libraryId) throws IOException, org.json.JSONException {
        return unwrap(requestWithCode("/org/libraries/" + libraryId, "GET", null, 8000));
    }

    /** 杩欎竴鍦哄悓浼犻€変簡鍝簺搴撱€?*/
    public JSONObject orgMeetingLibraries(String meetingId) throws IOException, org.json.JSONException {
        return unwrap(requestWithCode("/org/meeting/" + meetingId + "/libraries", "GET", null, 8000));
    }

    /** 淇濆瓨鍦ㄨ繖涓€鍦哄惎鐢ㄥ摢浜涘簱锛堢┖鏁扮粍 = 浠€涔堥兘涓嶅惎鐢級銆?*/
    public JSONObject orgSaveMeetingLibraries(String meetingId, org.json.JSONArray libraryIds)
            throws IOException, org.json.JSONException {
        JSONObject body = new JSONObject();
        body.put("libraryIds", libraryIds);
        return unwrap(requestWithCode("/org/meeting/" + meetingId + "/libraries", "PUT", body, 8000));
    }

    /** 鎴戠殑鐢宠锛堝惈鐘舵€侊細pending / approved / rejected / withdrawn锛夈€?*/
    public JSONObject orgMyRequests() throws IOException, org.json.JSONException {
        return unwrap(requestWithCode("/org/requests/mine", "GET", null, 8000));
    }

    /**
     * 鍙戝竷"杩欎竴鍦虹殑浼氳鏈"锛坉ocs/19锛夛細鏈嶅姟绔寜褰撳墠鍕鹃€夐噸寤轰竴浠斤紝鎻掍欢涓嬩竴鍙ュ氨鐢ㄤ笂銆?
     * <p>涓轰粈涔堜笉鍐嶇敤"/org/meeting/<id>/snapshot"锛氶偅浠芥槸鎸?鍦烘"瀛樼殑鏃ц矾寰勶紝
     * 鑰岀幇鍦ㄧ殑璇箟鏄?寮€濮嬪悓浼?鈫?鏈嶅姟绔彂甯冧竴浠藉綋鍓嶄細璁湳璇?锛屾彃浠跺彧璇诲浐瀹氳矾寰勩€?
     * <p>澶辫触涓嶈嚧鍛斤細鎵嬫満姣忔寮€濮嬪悓浼犳椂 relay 涔熶細鑷姩鍙戝竷涓€娆°€?
     */
    public JSONObject orgPublishMeetingTerms() throws IOException, org.json.JSONException {
        return unwrap(requestWithCode("/org/meeting/publish", "POST", new JSONObject(), 12000));
    }

    /** 褰撳墠杩欎竴鍦虹殑浼氳鏈锛堜細璁?id + 鏉℃暟 + 鍐茬獊锛夛紝鐢ㄤ簬鐣岄潰鏄剧ず鐘舵€併€?*/
    public JSONObject orgCurrentMeetingTerms() throws IOException, org.json.JSONException {
        return unwrap(requestWithCode("/org/meeting/current", "GET", null, 8000));
    }

    /**
     * 鎻愪氦鐢宠銆?
     * <p>鈿狅笍 璇锋眰浣撻噷**涓嶈**鏀?applicant锛氱敵璇蜂汉鐢辨湇鍔＄浠?token 瑙ｅ嚭鏉ワ紙鏀句簡涔熶細琚拷鐣ワ級銆?
     */
    public JSONObject orgCreateRequest(JSONObject request) throws IOException, org.json.JSONException {
        return unwrap(requestWithCode("/org/requests", "POST", request, 8000));
    }

    /** 閭楠岃瘉鐮佺櫥褰曪細鍏堝彇鐮侊紙鐮佹墦鍗板湪鐢佃剳绔?relay 鎺у埗鍙帮級锛屽啀鐧诲綍鎷?token銆?*/
    public JSONObject authRequestCode(String email) throws IOException, org.json.JSONException {
        JSONObject body = new JSONObject();
        body.put("email", email);
        return unwrap(requestWithCode("/auth/code", "POST", body, 8000));
    }

    /**
     * 娉ㄥ唽锛氶偖绠?+ 鐢ㄦ埛鍚?+ 瀵嗙爜 + 楠岃瘉鐮侊紙docs/19锛夈€?
     * <p>鐧诲綍涓嶇敤杩欎釜 鈥斺€?鐧诲綍璧?authLogin锛堢敤鎴峰悕 + 瀵嗙爜锛夈€?
     */
    public JSONObject authRegisterEmail(String email, String username, String password, String code)
            throws IOException, org.json.JSONException {
        JSONObject body = new JSONObject();
        body.put("email", email);
        body.put("username", username);
        body.put("password", password);
        body.put("code", code);
        return unwrap(requestWithCode("/auth/register-email", "POST", body, 8000));
    }

    /**
     * 涓€娆¤姹傦紝浣?*鎶婇潪 2xx 涔熷綋姝ｅ父杩斿洖**锛堣繑鍥?{ code, json }锛夈€?
     *
     * <p>涓轰粈涔堢儹璇嶈〃瑕佽繖涓細涓婁紶鏃?琛ㄩ噷鏈変竴澶勫啓閿?鏄?*姝ｅ父涓氬姟缁撴灉**锛?
     * 鑰屽畠甯︾潃 400 涓庨€愭潯鍘熷洜锛堢鍑犺銆佷粈涔堥敊锛夈€傜敤 request() 浼氭妸杩欐 JSON
     * 濉炶繘寮傚父娑堟伅閲岋紝鐣岄潰灏辨病娉曢€愭潯鏄剧ず浜嗐€傚叾浣欑鐐圭户缁敤 request()銆?
     */

    /** 401 就抛 SessionExpiredException，让界面统一提示"在别处登录"。 */
    public static void throwIfSessionExpired(org.json.JSONObject wrapper) throws SessionExpiredException {
        if (wrapper == null || wrapper.optInt("code", 0) != 401) {
            return;
        }
        String hint = "";
        org.json.JSONObject inner = wrapper.optJSONObject("json");
        if (inner != null) {
            hint = inner.optString("hint", inner.optString("error", ""));
        }
        String message = (hint == null || hint.isEmpty())
                ? "登录已失效（可能在别处登录），请重新登录"
                : ("登录已失效：" + hint + "（可能在别处登录）");
        throw new SessionExpiredException(message);
    }
    private JSONObject requestWithCode(String path, String method, JSONObject body, int readTimeoutMs)
            throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(baseUrl + path).openConnection();
        try {
            connection.setRequestMethod(method);
            connection.setRequestProperty("X-Leion-Secret", secret);
            // 鏈?token 灏卞甫涓婏細鏈嶅姟绔嵁姝ょ‘瀹?鎴戞槸璋?锛堢儹璇嶈〃鍙瀹冿級
            if (!token.isEmpty()) connection.setRequestProperty("X-Leion-Token", token);
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(readTimeoutMs);
            connection.setUseCaches(false);

            if (body != null) {
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                connection.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream out = connection.getOutputStream()) {
                    out.write(bytes);
                }
            }

            int code = connection.getResponseCode();
            InputStream stream = (code >= 200 && code < 300)
                    ? connection.getInputStream()
                    : connection.getErrorStream();
            String text = readAll(stream);
            JSONObject result = new JSONObject();
            result.put("code", code);
            org.json.JSONObject parsed;
            try {
                parsed = new org.json.JSONObject(text);
            } catch (org.json.JSONException error) {
                parsed = new org.json.JSONObject();
                parsed.put("error", text.length() > 300 ? text.substring(0, 300) : text);
            }
            result.put("json", parsed);
            // 401 = 会话失效（常见于"同一账号在别处登录"，旧 token 被吊销）
            // 这里不抛异常（requestWithCode 的语义是"把非 2xx 也当正常返回"），
            // 由调用方用 throwIfSessionExpired() 统一处理。
            return result;
        } catch (org.json.JSONException error) {
            throw new IOException("鍥炲寘涓嶆槸鍚堟硶 JSON锛? + error.getMessage());
        } finally {
            connection.disconnect();
        }
    }

    /**
     * 璇荤數鑴戜笂鐨勮繍琛屾椂璁剧疆锛堢幇鍦ㄥ彧鏈?`proofread`锛氭牎瀵瑰紑鍏筹級銆?
     *
     * <p>涓轰粈涔堜互鐢佃剳涓哄噯锛氬紑鍏崇湡姝ｇ殑鏁堟灉鍙戠敓鍦ㄧ數鑴戜晶锛堝畠鍐冲畾鎺掍笉鎺掔浜屾妯″瀷璋冪敤锛夈€?
     * 鎵嬫満濡傛灉鍙敼鏈湴鍋忓ソ锛屽氨浼氬彉鎴?鐣岄潰涓婂叧鐫€銆佺數鑴戜笂杩樺湪璺?鈥斺€旈偅鏄瘮娌℃湁寮€鍏虫洿绯熺殑浜嬨€?
     */
    public JSONObject settingsGet() throws IOException, org.json.JSONException {
        return requestWithCode("/settings", "GET", null, 8000);
    }

    /** 鎶婃牎瀵瑰紑鍏抽€佸埌鐢佃剳銆傚搷搴旈噷 `effectiveAt` 浼氬啓 `next-session`銆?*/
    public JSONObject settingsPutProofread(boolean enabled) throws IOException, org.json.JSONException {
        JSONObject body = new JSONObject();
        body.put("proofread", enabled);
        return requestWithCode("/settings", "PUT", body, 8000);
    }

    // 鈹€鈹€ 鍐呴儴 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

    private void pollLoop() {
        // 1) 鎻℃墜锛氶『渚块獙璇佸瘑閽ユ嬁閿欐病鎷块敊
        try {
            // 椤烘墜鎶ヤ笂"鎴戞槸璋?锛氱數鑴戞嵁姝よ涓嬭繖涓€鍦虹敤鍝紶鐑瘝琛紙鎶ラ敊浜嗕篃涓嶅奖鍝嶆彙鎵嬶級
            String helloPath = "/hello";
            if (!user.isEmpty()) {
                try {
                    helloPath = "/hello?user=" + java.net.URLEncoder.encode(user, "UTF-8");
                } catch (java.io.UnsupportedEncodingException ignored) {
                    helloPath = "/hello";
                }
            }
            JSONObject hello = request(helloPath, "GET", null, 8000);
            int cols = hello.optInt("cols", 40);
            int lineBudget = hello.optInt("lineBudget", 3);
            seq = hello.optLong("seq", 0);
            listener.onHello(hello.optString("device", "?"), cols, lineBudget);
            listener.onStatus("宸茶繛鎺ワ細" + hello.optString("device", "?")
                    + " 路 " + cols + " 鍒?脳 " + lineBudget + " 琛?);
        } catch (Exception error) {
            running = false;
            listener.onError("杩炴帴澶辫触锛? + describe(error));
            return;
        }

        // 2) 闀胯疆璇細娌℃湁鏂板抚鏃舵湇鍔＄浼氭妸璇锋眰鎸備綇锛堢害 25 绉掞級锛屾墍浠ヨ繖涓嶆槸蹇欑瓑
        while (running) {
            try {
                JSONObject response = request("/frame?since=" + seq, "GET", null, 35000);
                long serverSeq = response.optLong("seq", seq);
                // 搴忓彿閲嶇疆锛堣浆鍙戣繘绋嬮噸鍚繃锛夛細鎶婃湰鍦板簭鍙锋媺鍥炴湇鍔＄鐨勫€笺€?
                // 涓嶅仛杩欎竴姝ョ殑璇濓紝鎴戜滑璁扮殑搴忓彿浼氭案杩滃ぇ浜庢湇鍔＄锛屼箣鍚庢瘡涓€杞兘鍙兘鏀跺埌
                // "娌℃湁鏂板抚"锛屽瓧骞曞啀涔熶笉浼氫笂灞?鈥斺€?鑰屼笖瀹屽叏涓嶄細鎶ラ敊锛屾渶闅炬煡銆?
                if (serverSeq < seq) {
                    seq = serverSeq;
                }
                if (response.optBoolean("reset", false)) {
                    listener.onStatus("鐢佃剳渚у簭鍙峰凡閲嶇疆锛堣浆鍙戣繘绋嬮噸鍚繃锛夛紝宸茶嚜鍔ㄨ窡闅?);
                }
                if (response.optBoolean("changed", false)) {
                    seq = serverSeq;
                    JSONObject frame = response.optJSONObject("frame");
                    if (frame != null) {
                        JSONArray lines = frame.optJSONArray("lines");
                        int count = lines == null ? 0 : lines.length();
                        String[] out = new String[count];
                        for (int i = 0; i < count; i++) {
                            out[i] = lines.optString(i, "");
                        }
                        // 鐑瘝瑙傛祴锛坉ocs/15 搂17锛夛細鏈彞"鎻愬埌浜嗚〃鍐呭悕瀛椼€佷絾璇戞枃娌″啓鍑鸿鑼冨啓娉?鐨勬潯鐩€?
                        // 鐢佃剳渚у彧缁欎腑鏂囧悕锛坺h锛夛紝鎻愮ず鏂囨鐢辨墜鏈烘嫾 鈥斺€?杩欐牱鏂囨鏀硅捣鏉ヤ笉鐢ㄦ敼鐢佃剳銆?
                        JSONArray miss = frame.optJSONArray("termsMiss");
                        String[] missing = new String[miss == null ? 0 : miss.length()];
                        for (int i = 0; i < missing.length; i++) {
                            JSONObject item = miss.optJSONObject(i);
                            missing[i] = item == null ? "" : item.optString("zh", "");
                        }
                        listener.onFrame(
                                frame.optString("speaker", "them"),
                                frame.optString("lang", "?"),
                                out,
                                frame.optString("text", ""),
                                frame.optString("source", ""),
                                frame.optString("sourceLang", "unknown"),
                                frame.optBoolean("partial", false),
                                missing);
                    }
                }
            } catch (Exception error) {
                if (!running) {
                    break;
                }
                listener.onError("鍙栧瓧骞曞け璐ワ細" + describe(error));
                try {
                    Thread.sleep(2000);
                } catch (InterruptedException ignored) {
                    break;
                }
            }
        }
    }

    /** 涓€娆¤姹傘€傞潪 2xx 涓€寰嬫姏寮傚父锛堟妸鏈嶅姟绔殑閿欒姝ｆ枃甯﹀嚭鏉ワ紝渚夸簬鎺掓煡锛夈€?*/
    private JSONObject request(String path, String method, JSONObject body, int readTimeoutMs)
            throws IOException, org.json.JSONException {
        HttpURLConnection connection = (HttpURLConnection) new URL(baseUrl + path).openConnection();
        try {
            connection.setRequestMethod(method);
            connection.setRequestProperty("X-Leion-Secret", secret);
            // 鏈?token 灏卞甫涓婏細鏈嶅姟绔嵁姝ょ‘瀹?鎴戞槸璋?锛堢儹璇嶈〃鍙瀹冿級
            if (!token.isEmpty()) connection.setRequestProperty("X-Leion-Token", token);
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(readTimeoutMs);
            connection.setUseCaches(false);

            if (body != null) {
                byte[] bytes = body.toString().getBytes(StandardCharsets.UTF_8);
                connection.setDoOutput(true);
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                connection.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream out = connection.getOutputStream()) {
                    out.write(bytes);
                }
            }

            int code = connection.getResponseCode();
            InputStream stream = (code >= 200 && code < 300)
                    ? connection.getInputStream()
                    : connection.getErrorStream();
            String text = readAll(stream);

            if (code < 200 || code >= 300) {
                String hint = "";
                if (code == 401) {
                    hint = "锛堝叡浜瘑閽ヤ笉瀵癸級";
                }
                throw new IOException("HTTP " + code + hint + " " + text);
            }
            return new JSONObject(text);
        } finally {
            connection.disconnect();
        }
    }

    /**
     * 涓€娆?璇锋眰浣撴槸鍘熷瀛楄妭"鐨勮姹傦紙闊抽涓婁紶鐢級銆?
     * 涓庝笂闈㈤偅涓垎寮€鍐欙紝鏄洜涓洪煶棰戜笉鏄?JSON锛岃€屼笖**蹇呴』璁?Content-Type: application/octet-stream**
     * 骞剁敤鍥哄畾闀垮害 鈥斺€?璁╂湇鍔＄鑳界洿鎺ユ寜瀛楄妭鏀讹紝涓嶅繀鍘荤寽缂栫爜銆?
     */
    private JSONObject requestRaw(String path, byte[] payload, int readTimeoutMs)
            throws IOException, org.json.JSONException {
        HttpURLConnection connection = (HttpURLConnection) new URL(baseUrl + path).openConnection();
        try {
            connection.setRequestMethod("POST");
            connection.setRequestProperty("X-Leion-Secret", secret);
            connection.setRequestProperty("Content-Type", "application/octet-stream");
            connection.setConnectTimeout(5000);
            connection.setReadTimeout(readTimeoutMs);
            connection.setUseCaches(false);
            connection.setDoOutput(true);
            connection.setFixedLengthStreamingMode(payload.length);
            try (OutputStream out = connection.getOutputStream()) {
                out.write(payload);
            }

            int code = connection.getResponseCode();
            InputStream stream = (code >= 200 && code < 300)
                    ? connection.getInputStream()
                    : connection.getErrorStream();
            String text = readAll(stream);
            if (code < 200 || code >= 300) {
                String hint = (code == 401) ? "锛堝叡浜瘑閽ヤ笉瀵癸級" : (code == 413 ? "锛堥煶棰戝潡澶ぇ锛? : "");
                throw new IOException("HTTP " + code + hint + " " + text);
            }
            return new JSONObject(text);
        } finally {
            connection.disconnect();
        }
    }

    private static String readAll(InputStream stream) throws IOException {
        if (stream == null) {
            return "";
        }
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[4096];
        int read;
        while ((read = stream.read(chunk)) > 0) {
            buffer.write(chunk, 0, read);
        }
        stream.close();
        return buffer.toString("UTF-8");
    }

    private static String describe(Exception error) {
        String message = error.getMessage();
        if (message == null || message.isEmpty()) {
            return error.getClass().getSimpleName();
        }
        return message;
    }

    // 鈹€鈹€ Rooms (P2a) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    /** Create a room; server returns a 6-digit invite code. */
    public JSONObject orgCreateRoom(String name) throws IOException, org.json.JSONException {
        return orgCreateRoom(name, null);
    }

    /** 寤烘埧骞跺０鏄?鎴戝湪浼氶噷璇翠粈涔堣瑷€"锛堟湇鍔＄鎹鍐冲畾璇嗗埆涓庣炕璇戞柟鍚戯級銆?*/
    public JSONObject orgCreateRoom(String name, String lang) throws IOException, org.json.JSONException {
        JSONObject body = new JSONObject();
        body.put("name", name);
        if (lang != null && !lang.isEmpty()) {
            body.put("lang", lang);
        }
        return unwrap(requestWithCode("/org/rooms", "POST", body, 8000));
    }

    /** Join by 6-digit code (idempotent). */
    public JSONObject orgJoinRoom(String code) throws IOException, org.json.JSONException {
        return orgJoinRoom(code, null);
    }

    /** 鍑爜鍔犲叆骞跺０鏄?鎴戝湪杩欎細閲岃浠€涔堣瑷€"銆?*/
    public JSONObject orgJoinRoom(String code, String lang) throws IOException, org.json.JSONException {
        JSONObject body = new JSONObject();
        body.put("code", code);
        if (lang != null && !lang.isEmpty()) {
            body.put("lang", lang);
        }
        return unwrap(requestWithCode("/org/rooms/join", "POST", body, 8000));
    }

    /** Room info: members + selected libraries. Accepts room id or invite code. */
    public JSONObject orgRoomInfo(String roomIdOrCode) throws IOException, org.json.JSONException {
        return unwrap(requestWithCode("/org/rooms/" + roomIdOrCode, "GET", null, 8000));
    }

    /** Persist room library selection; server freezes a meeting-terms snapshot. */
    public JSONObject orgSetRoomLibraries(String roomIdOrCode, org.json.JSONArray libraryIds)
            throws IOException, org.json.JSONException {
        JSONObject body = new JSONObject();
        body.put("libraryIds", libraryIds);
        return unwrap(requestWithCode("/org/rooms/" + roomIdOrCode + "/libraries", "POST", body, 15000));
    }

    /** Leave the room. Host leaving closes the room for everyone. */
    public JSONObject orgLeaveRoom(String roomIdOrCode) throws IOException, org.json.JSONException {
        JSONObject body = new JSONObject();
        body.put("roomId", roomIdOrCode);
        return unwrap(requestWithCode("/org/rooms/leave", "POST", body, 8000));
    }

    // 鈹€鈹€ Speaking right (P2b) 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    /** Current floor state: holder / locked / leaseMs. */
    public JSONObject floorGet(String roomIdOrCode) throws IOException, org.json.JSONException {
        return unwrap(requestWithCode("/org/rooms/" + roomIdOrCode + "/floor", "GET", null, 8000));
    }

    /** action = take | release | lock | unlock | heartbeat | force-release */
    public JSONObject floorAction(String roomIdOrCode, String action)
            throws IOException, org.json.JSONException {
        JSONObject body = new JSONObject();
        body.put("action", action);
        // 409 means "rejected by rules" (locked by someone else); we still want the body.
        JSONObject wrapper = requestWithCode("/org/rooms/" + roomIdOrCode + "/floor", "POST", body, 8000);
        JSONObject json = wrapper.optJSONObject("json");
        if (json == null) json = new JSONObject();
        json.put("_status", wrapper.optInt("code", 0));
        return json;
    }
}
