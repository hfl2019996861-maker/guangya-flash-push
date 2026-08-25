export const APP_VERSION = "2.1.6";
export const GITHUB_URL = "https://github.com/hfl2019996861-maker/guangya-flash-push";
export const RELEASES_URL = `${GITHUB_URL}/releases`;
export const LATEST_RELEASE_API =
  "https://api.github.com/repos/hfl2019996861-maker/guangya-flash-push/releases/latest";

export function compareVersions(left, right) {
  const normalize = (value) =>
    String(value || "")
      .trim()
      .replace(/^v/i, "")
      .split(/[.-]/)
      .map((part) => Number(part) || 0);
  const leftParts = normalize(left);
  const rightParts = normalize(right);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const diff = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (diff) return diff > 0 ? 1 : -1;
  }
  return 0;
}
