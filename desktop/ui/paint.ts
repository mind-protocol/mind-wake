interface Point {
  x: number;
  y: number;
  start?: boolean;
}
const canvas = document.getElementById("paint") as HTMLCanvasElement;
const context = canvas.getContext("2d")!;
let prior: Point | undefined, mid: Point | undefined;
let eraseTimer: ReturnType<typeof setTimeout> | undefined;
const clearPaint = (): void => {
  if (eraseTimer !== undefined) clearTimeout(eraseTimer);
  eraseTimer = undefined;
  context.clearRect(0, 0, innerWidth, innerHeight);
  prior = undefined;
  mid = undefined;
};
const expirePaint = (): void => {
  if (eraseTimer !== undefined) clearTimeout(eraseTimer);
  eraseTimer = setTimeout(clearPaint, 15_000);
};
function size(): void {
  canvas.width = Math.round(innerWidth * devicePixelRatio);
  canvas.height = Math.round(innerHeight * devicePixelRatio);
  context.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  context.strokeStyle = "#ff0000";
  context.fillStyle = "#ff0000";
  context.lineWidth = 5;
  context.lineCap = "round";
  context.lineJoin = "round";
  prior = undefined;
  mid = undefined;
}
size();
addEventListener("resize", size);
const event = (
  window as unknown as {
    __TAURI__: {
      event: {
        listen(name: string, callback: (event: { payload: Point }) => void): Promise<unknown>;
      };
    };
  }
).__TAURI__.event;
void event.listen("paint-point", ({ payload: point }) => {
  expirePaint();
  if (point.start || !prior) {
    prior = point;
    mid = point;
    context.beginPath();
    context.arc(point.x, point.y, 2.5, 0, Math.PI * 2);
    context.fill();
    return;
  }
  const next = { x: (prior.x + point.x) / 2, y: (prior.y + point.y) / 2 };
  context.beginPath();
  context.moveTo(mid!.x, mid!.y);
  context.quadraticCurveTo(prior.x, prior.y, next.x, next.y);
  context.stroke();
  mid = next;
  prior = point;
});
void event.listen("paint-end", () => {
  expirePaint();
  if (prior && mid) {
    context.beginPath();
    context.moveTo(mid.x, mid.y);
    context.lineTo(prior.x, prior.y);
    context.stroke();
  }
  prior = undefined;
  mid = undefined;
});
void event.listen("paint-clear", () => {
  clearPaint();
});
