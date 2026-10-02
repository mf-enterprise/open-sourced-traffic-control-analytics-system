const heading = document.getElementById("heading");
const detail = document.getElementById("detail");
const progress = document.getElementById("progress");
const retry = document.getElementById("retry");
window.trafficControlSetup.onStatus((status) => {
  heading.textContent = status.title;
  detail.textContent = status.detail;
  retry.hidden = !status.error;
  if (Number.isFinite(status.percent)) progress.value = status.percent;
  else progress.removeAttribute("value");
});
retry.addEventListener("click", () => {
  retry.hidden = true;
  void window.trafficControlSetup.retry();
});
