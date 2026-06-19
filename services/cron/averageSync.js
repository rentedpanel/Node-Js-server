const db = require('../../config/db');

const SAMPLE_SIZE = 9;

function formatAverageTime(averageSeconds) {
  const hours = Math.floor(averageSeconds / 3600);
  const minutes = Math.floor((averageSeconds % 3600) / 60);

  if (hours === 0 && minutes === 0) return 'Not enough data';
  if (hours === 0 && minutes === 1) return `${minutes} Minute`;
  if (hours === 0) return `${minutes} Minutes`;
  if (hours === 1 && minutes === 0) return `${hours} Hour`;
  if (minutes === 0) return `${hours} Hours`;
  return `${hours} hours and ${minutes} minutes`;
}

async function runAverageSync() {
  const services = await db.query('SELECT service_id FROM services');

  for (const service of services) {
    const orders = await db.query(
      `SELECT order_create, last_check FROM orders
       WHERE order_status = 'completed' AND order_quantity = '1000' AND service_id = ?
       ORDER BY order_id DESC LIMIT ?`,
      [service.service_id, SAMPLE_SIZE]
    );

    if (!orders?.length) continue;

    let totalTime = 0;
    for (const order of orders) {
      const t1 = new Date(order.order_create).getTime();
      const t2 = new Date(order.last_check).getTime();
      totalTime += Math.abs(t2 - t1);
    }

    const averageSeconds = totalTime / orders.length / 1000;
    const average = formatAverageTime(averageSeconds);

    await db.query('UPDATE services SET time = ? WHERE service_id = ?', [average, service.service_id]);
  }
}

module.exports = { runAverageSync };
