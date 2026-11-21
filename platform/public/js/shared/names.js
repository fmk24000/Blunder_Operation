/** v0.4.9：玩家名正規化／長度／撞名比較（server 同 client 共用） */
export const NAME_MAX = 10;
/** 原始字串上限：避免一個 name 用幾百個 combining mark 塞爆所有 view。 */
export const NAME_RAW_MAX = 200;
/** 舊 browser（例如 Firefox 124）冇 Intl.Segmenter：fallback 用 code point，至少唔會 crash 成個 /play。 */
const SEGMENTER = typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter("zh-Hant", { granularity: "grapheme" })
    : null;
/** 顯示用：trim、連續空白收成一個空格、NFC。 */
export function normalizeName(raw) {
    return String(raw ?? "")
        .normalize("NFC")
        .trim()
        .replace(/\s+/g, " ");
}
/** 比較用：NFKC（全形字母 → 普通字母）＋細楷；中文不受影響。 */
export function nameKey(raw) {
    // NFKC＋細楷；ς→σ 令 Greek final sigma 都當同一個 case（Unicode case-fold 嘅實用近似）
    return normalizeName(raw).normalize("NFKC").toLowerCase().replace(/ς/g, "σ");
}
function segments(raw) {
    const s = String(raw ?? "");
    if (!s)
        return [];
    if (!SEGMENTER)
        return [...s];
    return [...SEGMENTER.segment(s)].map((part) => part.segment);
}
/** 以 grapheme 計字數：emoji／組合字都當一個「字」。 */
export function nameLength(raw) {
    return segments(normalizeName(raw)).length;
}
export function isValidName(raw) {
    if (String(raw ?? "").length > NAME_RAW_MAX)
        return false;
    const n = nameLength(raw);
    return n >= 1 && n <= NAME_MAX;
}
/** 輸入用：保留用戶打緊嘅空白，只按 grapheme 截到 NAME_MAX（唔好邊打邊 trim）。 */
export function clampName(raw) {
    // 冇 Segmenter 嘅舊 browser：唔好亂切（可能切散 emoji），交返 server 驗
    if (!SEGMENTER)
        return String(raw ?? "");
    return segments(raw).slice(0, NAME_MAX).join("");
}
/** 提交用：先 normalize（trim／收空白），再按 grapheme 截。 */
export function truncateName(raw) {
    return clampName(normalizeName(raw));
}
