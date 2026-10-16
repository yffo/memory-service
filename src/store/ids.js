/**
 * ULID —— **转发层**，实现只有一处：`src/util/ulid.js`。
 *
 * 为什么留这个文件而不是删掉：`core/` 与 `store/` 的历史调用点写的是
 * `store/ids.js`，而测试需要 `resetUlidState()`（清掉同毫秒单调计数，
 * 否则用例之间会互相污染）。算法实现两份是这里曾经的样子，两份都「能用」，
 * 但那意味着修一处碰撞 bug 要记得改两处——所以实现留一份、API 留两份。
 *
 * 口径（与 `util/ulid.js` 完全一致）：
 *  - 前 10 位毫秒时间戳（Crockford base32），后 16 位随机；
 *  - 同一毫秒内单调递增（`+1` 进位），不用等时钟前进；
 *  - 大小写都收，输出统一大写。
 */
import { ulid, isUlid, ulidTime, ULID_ALPHABET } from '../util/ulid.js';

export { ulid, isUlid, ulidTime, ULID_ALPHABET };

/** 测试用：清掉默认生成器的单调状态（`Date.now()` 被冻结时可造确定性序列）。 */
export function resetUlidState() {
  ulid.reset();
}
