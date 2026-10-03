// POST /orders handler.
export function createOrder(body) {
  const total = body.items.reduce((sum, item) => sum + item.price * item.qty, 0);
  return { id: Date.now(), total };
}
