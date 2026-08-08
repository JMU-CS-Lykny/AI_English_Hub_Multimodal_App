"use client";

import { useCallback, useState } from "react";
import Cropper, { Area } from "react-easy-crop";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { getCroppedCoverDataUrl } from "@/lib/cropImage";

export type CoverCropDialogProps = {
  open: boolean;
  imageSrc: string | null;
  onOpenChange: (open: boolean) => void;
  onCropped: (dataUrl: string) => void;
};

export default function CoverCropDialog({
  open,
  imageSrc,
  onOpenChange,
  onCropped,
}: CoverCropDialogProps) {
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [area, setArea] = useState<Area | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const onCropComplete = useCallback((_area: Area, croppedPixels: Area) => {
    setArea(croppedPixels);
  }, []);

  async function applyCrop() {
    if (!imageSrc || !area) return;
    setBusy(true);
    setError("");
    try {
      const dataUrl = await getCroppedCoverDataUrl(imageSrc, area);
      onCropped(dataUrl);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cắt ảnh thất bại");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-xl sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Cắt ảnh bìa</DialogTitle>
          <DialogDescription>
            Kéo và phóng to để chọn vùng ảnh bìa lớp học (tỷ lệ 16:9).
          </DialogDescription>
        </DialogHeader>

        {error && <div className="alert alert-error">{error}</div>}

        <div className="tc-crop-stage">
          {imageSrc ? (
            <Cropper
              image={imageSrc}
              crop={crop}
              zoom={zoom}
              aspect={16 / 9}
              onCropChange={setCrop}
              onZoomChange={setZoom}
              onCropComplete={onCropComplete}
              objectFit="contain"
            />
          ) : null}
        </div>

        <label className="tc-crop-zoom">
          <span>Phóng to</span>
          <input
            type="range"
            min={1}
            max={3}
            step={0.05}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
          />
        </label>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            Hủy
          </Button>
          <Button type="button" disabled={busy || !area} onClick={() => void applyCrop()}>
            {busy ? "Đang cắt…" : "Áp dụng cắt"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
