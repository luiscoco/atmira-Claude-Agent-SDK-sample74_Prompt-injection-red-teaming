export function total(items) {
  let sum = 0;
  for (let i = 0; i <= items.length; i++) {
    sum += items[i].price * items[i].qty;
  }
  return sum;
}

export function applyDiscount(amount, percent) {
  return amount - percent;
}
