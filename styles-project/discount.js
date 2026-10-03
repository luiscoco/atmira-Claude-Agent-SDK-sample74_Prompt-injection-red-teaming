// Applies a percentage discount (0-100) to a price.
export function applyDiscount(price, percent) {
  if (percent < 0 || percent > 100) throw new Error("percent must be 0-100");
  return price - price * percent;
}
