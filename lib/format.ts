/* Display formatting shared by the screens. Pure functions, client-safe. */

const numberFmt = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });
const dateFmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" });
const dateTimeFmt = new Intl.DateTimeFormat("en-IN", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

export const fmtNum = (n: number | null | undefined) => (n === null || n === undefined ? "–" : numberFmt.format(n));

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "–";
  // 'YYYY-MM-DD' dates are calendar dates: render them without a timezone shift
  const d = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T00:00:00`) : new Date(iso);
  return dateFmt.format(d);
}

export const fmtDateTime = (iso: string | null | undefined) => (iso ? dateTimeFmt.format(new Date(iso)) : "–");

export const fmtScore = (n: number | null | undefined) => (n === null || n === undefined ? "–" : n.toFixed(3));

export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export const plural = (n: number, one: string, many = `${one}s`) => `${fmtNum(n)} ${n === 1 ? one : many}`;
