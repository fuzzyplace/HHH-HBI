// Camera input: your movement in front of the screen. A 64×48 copy of each frame is reduced to motion, position
// and light by src/dsp/vision.js; no frame is kept, recorded or sent anywhere. The video element is never shown.
import { VisionFeatures } from '../dsp/vision.js';

const W = 64, H = 48, FRAME_MS = 66;   // ~15 fps is plenty for gesture-scale motion

export default class CameraInput {
  static id = 'camera';
  static label = 'Camera';
  static rest = { motion: 0, x: 0, y: 0, vx: 0, vy: 0, light: 0 };

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('this browser has no camera access');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 320 }, height: { ideal: 240 }, facingMode: 'user' }, audio: false });
    } catch (e) {
      throw new Error(e.name === 'NotAllowedError' ? 'camera permission was declined' : e.name === 'NotFoundError' ? 'no camera found' : e.message);
    }
    this.video = Object.assign(document.createElement('video'), { muted: true, playsInline: true, srcObject: this.stream });
    await this.video.play();
    this.cv = document.createElement('canvas'); this.cv.width = W; this.cv.height = H;
    this.ctx = this.cv.getContext('2d', { willReadFrequently: true });
    this.vision = new VisionFeatures(); this.last = 0;
  }
  stop() {
    for (const t of this.stream?.getTracks() || []) t.stop();
    if (this.video) this.video.srcObject = null;
    this.stream = this.video = null;
  }
  read(out, now) {
    if (!this.video || now - this.last < FRAME_MS || this.video.readyState < 2) return;
    const dt = this.last ? (now - this.last) / 1000 : FRAME_MS / 1000;
    this.last = now;
    this.ctx.drawImage(this.video, 0, 0, W, H);
    const f = this.vision.update(this.ctx.getImageData(0, 0, W, H).data, W, H, dt);
    out.motion = f.motion; out.x = f.x; out.y = f.y; out.vx = f.vx; out.vy = f.vy; out.light = f.light;
  }
}
