// Shrinking pictures in the browser before upload, so logos and covers stay small and pages stay fast.

/** Fits an image inside maxW x maxH (keeping its shape) and returns a data URL of the given type. */
export function shrinkImage(file: File, maxW: number, maxH = maxW, type: 'image/png' | 'image/jpeg' = 'image/png', quality = 0.85): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const k = Math.min(1, maxW / img.width, maxH / img.height);
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
      c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL(type, quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad image')); };
    img.src = url;
  });
}
