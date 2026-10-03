// The Orbit storefront.
export function renderCart(cart) {
  return cart.items.map((item) => `${item.name} x${item.qty}`).join('\n');
}
