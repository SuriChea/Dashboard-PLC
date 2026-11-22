export function calculateUsageLiter(
  previousFlowRate: number,
  currentFlowRate: number,
  elapsedMilliseconds: number,
) {
  if (
    !Number.isFinite(previousFlowRate) ||
    !Number.isFinite(currentFlowRate) ||
    !Number.isFinite(elapsedMilliseconds) ||
    previousFlowRate < 0 ||
    currentFlowRate < 0 ||
    elapsedMilliseconds < 0
  ) {
    throw new Error("Flow rates and elapsed time must be finite non-negative numbers");
  }
  const elapsedMinutes = elapsedMilliseconds / 60000;
  return ((previousFlowRate + currentFlowRate) / 2) * elapsedMinutes;
}

export function splitUsageByUtcDay(start: Date, end: Date, averageFlowRate: number) {
  const startTime = start.getTime();
  const endTime = end.getTime();
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || endTime <= startTime || !Number.isFinite(averageFlowRate) || averageFlowRate < 0) {
    throw new Error("Usage interval must be valid and flow rate must be non-negative");
  }
  const intervals: { date: Date; liters: number }[] = [];
  let cursor = startTime;
  while (cursor < endTime) {
    const date = new Date(cursor);
    const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const nextDay = day.getTime() + 86400000;
    const segmentEnd = Math.min(endTime, nextDay);
    intervals.push({
      date: day,
      liters: calculateUsageLiter(averageFlowRate, averageFlowRate, segmentEnd - cursor),
    });
    cursor = segmentEnd;
  }
  return intervals;
}
