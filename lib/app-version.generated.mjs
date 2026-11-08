/**
 * app-version.generated.mjs —— **自动生成，别手改**（源头是 android/app/build.gradle.kts）
 * ============================================================================
 * 跑 `node scripts/generate.mjs` 重新生成；`--check` 会校验它与 gradle 是否一致。
 *
 * 手机端的强制更新门禁（5.26）用的就是这个值：`GET /version` 回它，
 * 手机拿自己的 versionCode 与 `code` 比大小。
 */

export const APP_VERSION = Object.freeze({
  name: "4.263",
  code: 292,
})

export default APP_VERSION
