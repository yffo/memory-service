/**
 * ULID（Crockford base32，26 字符）：前 10 位毫秒时间戳、后 16 位随机。
 *
 * 为什么自己写而不是装包：架构文档 §M1 要求零运行时依赖（`04-cost-model.md` 的
 * 默认档「装上就跑」也是同一条理由）。ULID 的算法只有两个要点（时间有序 + 单调），
 * 三十行能写完，比引一个包更好审。
 *
 * 三条性质是我们真正在用的：
 *  1. **时间有序**：同一毫秒内按生成顺序递增（`lastRandom` 单调进位），
 *     所以 `notes/` 目录按文件名排序就是写入顺序 —— `status` 与 `list` 不必读 mtime。
 *  2. **碰撞安全**：同毫秒内随机位 +1，不用等时钟前进。
 *  3. **可注入**：`rand` 可传，测试里给确定性字节即可复现 id。
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function encodeTime(ms, len) {
  let out = '';
  let t = Math.floor(ms);
  for (let i = len - 1; i >= 0; i -= 1) {
    out = ALPHABET[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function randomBytes(rand) {
  const bytes = new Uint8Array(RANDOM_LEN);
  if (typeof rand === 'function') {
    const given = rand(RANDOM_LEN);
    for (let i = 0; i < RANDOM_LEN; i += 1) bytes[i] = Number(given?.[i] ?? 0) & 0xff;
    return bytes;
  }
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
  }
  for (let i = 0; i < RANDOM_LEN; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  return bytes;
}

function encodeRandom(bytes) {
  let out = '';
  for (let i = 0; i < RANDOM_LEN; i += 1) out += ALPHABET[bytes[i] % 32];
  return out;
}

/** 创建一台生成器；`{ rand }` 可注入确定性随机源（测试用）。 */
export function createUlidFactory(options = {}) {
  let lastMs = -1;
  let lastTime = '';
  let lastRand = '';
  const rand = options.rand;

  function ulid(ms = Date.now()) {
    const stamp = Math.floor(ms);
    if (stamp === lastMs) {
      // 同毫秒：在上一枚的随机段上 +1（Crockford 单调进位）。
      const chars = lastRand.split('');
      let i = chars.length - 1;
      for (; i >= 0; i -= 1) {
        const idx = ALPHABET.indexOf(chars[i]);
        if (idx < 31) {
          chars[i] = ALPHABET[idx + 1];
          break;
        }
        chars[i] = ALPHABET[0];
      }
      lastRand = chars.join('');
      return lastTime + lastRand;
    }
    lastMs = stamp;
    lastTime = encodeTime(stamp, TIME_LEN);
    lastRand = encodeRandom(randomBytes(rand));
    return lastTime + lastRand;
  }

  /** 清掉单调状态（测试要造确定性序列时用；生产不该调）。 */
  ulid.reset = () => {
    lastMs = -1;
    lastTime = '';
    lastRand = '';
  };

  return ulid;
}

/** 默认生成器（进程内单调）。 */
export const ulid = createUlidFactory();

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** 形状校验：只认 26 位 Crockford base32（大小写不敏感，输出统一大写）。 */
export function isUlid(value) {
  return typeof value === 'string' && ULID_RE.test(value.trim().toUpperCase());
}

/** 从 ULID 还原毫秒时间戳；不是合法 ULID 返回 null。 */
export function ulidTime(value) {
  if (!isUlid(value)) return null;
  const s = value.trim().toUpperCase();
  let ms = 0;
  for (let i = 0; i < TIME_LEN; i += 1) ms = ms * 32 + ALPHABET.indexOf(s[i]);
  return ms;
}

export const ULID_ALPHABET = ALPHABET;
