/**
 * Lists the backends whose pricing pages have not been re-read lately.
 * `npm run stale` prints them; `npm run stale -- --days 60` changes the limit.
 * The weekly workflow runs this and opens an issue when the list is not empty.
 * Exits with 1 when something is stale, so it can gate a job.
 */
import { VENDORS } from "../app/pricing/vendors";

const flag = process.argv.indexOf("--days");
const limit = flag > 0 ? Number(process.argv[flag + 1]) : 90;
if (!Number.isFinite(limit) || limit <= 0) {
  console.error("--days needs a positive number");
  process.exit(2);
}

const today = Date.now();
// A date that does not parse can't be judged fresh, so it is listed first.
const stale = VENDORS.map((vendor) => {
  const read = /^\d{4}-\d{2}-\d{2}$/.test(vendor.checkedOn)
    ? Date.parse(`${vendor.checkedOn}T00:00:00Z`)
    : NaN;
  const days = Math.floor((today - read) / 86_400_000);
  return { vendor, days: Number.isFinite(days) ? days : Infinity };
})
  .filter((entry) => entry.days > limit)
  .sort((a, b) => b.days - a.days);

if (stale.length === 0) {
  console.log(`Every backend was read within the last ${limit} days.`);
  process.exit(0);
}

console.log(`Not re-read in more than ${limit} days:\n`);
for (const { vendor, days } of stale) {
  const when =
    days === Infinity
      ? `checkedOn "${vendor.checkedOn}" is not a YYYY-MM-DD date`
      : `read ${vendor.checkedOn} (${days} days ago)`;
  console.log(`- ${vendor.name}: ${when}. ${vendor.pricingUrl}`);
  console.log(`  app/pricing/vendors/${vendor.id}.ts`);
}
process.exit(1);
