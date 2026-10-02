export async function closeServiceResources({
  initialRecovery,
  monitor,
  cameras,
  localCameras,
  trafficCameras,
  storage,
}) {
  const errors = [];
  try {
    await initialRecovery;
  } catch (error) {
    errors.push(error);
  }
  const owners = await Promise.allSettled([
    Promise.resolve().then(() => monitor.close()),
    Promise.resolve().then(() => cameras.close()),
    Promise.resolve().then(() => localCameras?.close()),
    Promise.resolve().then(() => trafficCameras?.close()),
  ]);
  for (const result of owners)
    if (result.status === "rejected") errors.push(result.reason);
  for (const resource of storage) {
    try {
      resource?.close();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(
      errors,
      "Local service cleanup could not be fully confirmed.",
    );
}
