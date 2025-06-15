function safeNumber(val) {
  const num = parseFloat(val);
  return isNaN(num) ? 0 : num;
}

function calculateMonthlyConsumption(readings) {
  const monthly = {};
  readings.forEach(record => {
    const monthKey = record.date.substring(0, 7);
    const meter = record.meter;
    if (!monthly[meter]) {
      monthly[meter] = {};
    }
    if (!monthly[meter][monthKey]) {
      monthly[meter][monthKey] = { min: safeNumber(record.kWHNet), max: safeNumber(record.kWHNet) };
    } else {
      monthly[meter][monthKey].min = Math.min(monthly[meter][monthKey].min, safeNumber(record.kWHNet));
      monthly[meter][monthKey].max = Math.max(monthly[meter][monthKey].max, safeNumber(record.kWHNet));
    }
  });
  const consumption = {};
  for (const meter in monthly) {
    consumption[meter] = {};
    for (const month in monthly[meter]) {
      consumption[meter][month] = monthly[meter][month].max - monthly[meter][month].min;
    }
  }
  return { monthly, consumption };
}

module.exports = { safeNumber, calculateMonthlyConsumption };
