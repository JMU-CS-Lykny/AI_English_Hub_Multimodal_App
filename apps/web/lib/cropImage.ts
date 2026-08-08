export type CropArea = {
  x: number;
  y: number;
  width: number;
  height: number;
};

function loadImage(src: string, crossOrigin?: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (crossOrigin) img.crossOrigin = crossOrigin;
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Không tải được ảnh để cắt"));
    img.src = src;
  });
}

/** Rasterize SVG / remote images to a JPEG data URL for reliable cropping. */
export async function ensureRasterDataUrl(
  src: string,
  maxEdge = 1280,
  quality = 0.88,
): Promise<string> {
  const isRemote = /^https?:\/\//i.test(src);
  const img = await loadImage(src, isRemote ? "anonymous" : undefined);
  const scale = Math.min(1, maxEdge / Math.max(img.width || 1, img.height || 1));
  const width = Math.max(1, Math.round((img.width || maxEdge) * scale));
  const height = Math.max(1, Math.round((img.height || maxEdge * 0.6) * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Không xử lý được ảnh");
  ctx.fillStyle = "#0f3d3e";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", quality);
}

/** Crop a pixel area from an image source into a JPEG data URL. */
export async function getCroppedCoverDataUrl(
  imageSrc: string,
  crop: CropArea,
  outputWidth = 960,
  quality = 0.82,
): Promise<string> {
  const isRemote = /^https?:\/\//i.test(imageSrc);
  const image = await loadImage(imageSrc, isRemote ? "anonymous" : undefined);
  const canvas = document.createElement("canvas");
  const aspect = crop.width / Math.max(1, crop.height);
  const width = outputWidth;
  const height = Math.max(1, Math.round(outputWidth / aspect));
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Không cắt được ảnh");
  ctx.drawImage(
    image,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    width,
    height,
  );
  return canvas.toDataURL("image/jpeg", quality);
}
