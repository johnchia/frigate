import Heading from "@/components/ui/heading";
import { FrigateConfig } from "@/types/frigateConfig";
import useSWR from "swr";
import axios from "axios";
import ActivityIndicator from "@/components/indicators/activity-indicator";
import AutoUpdatingCameraImage from "@/components/camera/AutoUpdatingCameraImage";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import {
  useImproveContrast,
  useMotionContourArea,
  useMotionThreshold,
} from "@/api/ws";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { Separator } from "@/components/ui/separator";
import { Link } from "react-router-dom";
import { LuExternalLink } from "react-icons/lu";
import { Trans, useTranslation } from "react-i18next";
import { useDocDomain } from "@/hooks/use-doc-domain";
import { cn } from "@/lib/utils";
import { isDesktop } from "react-device-detect";
import { useResizeObserver } from "@/hooks/resize-observer";

type MotionTunerViewProps = {
  selectedCamera: string;
  setUnsavedChanges: React.Dispatch<React.SetStateAction<boolean>>;
};

type MotionSettings = {
  threshold?: number;
  contour_area?: number;
  improve_contrast?: boolean;
};

type TunedControl = "threshold" | "contourArea";

export default function MotionTunerView({
  selectedCamera,
  setUnsavedChanges,
}: MotionTunerViewProps) {
  const { t } = useTranslation(["views/settings"]);
  const { getLocaleDocUrl } = useDocDomain();
  const { data: config, mutate: updateConfig } =
    useSWR<FrigateConfig>("config");
  const [changedValue, setChangedValue] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  const { send: sendMotionThreshold } = useMotionThreshold(selectedCamera);
  const { send: sendMotionContourArea } = useMotionContourArea(selectedCamera);
  const { send: sendImproveContrast } = useImproveContrast(selectedCamera);

  const [motionSettings, setMotionSettings] = useState<MotionSettings>({
    threshold: undefined,
    contour_area: undefined,
    improve_contrast: undefined,
  });

  const [origMotionSettings, setOrigMotionSettings] = useState<MotionSettings>({
    threshold: undefined,
    contour_area: undefined,
    improve_contrast: undefined,
  });

  const userInteractedRef = useRef(false);

  const cameraConfig = useMemo(() => {
    if (config && selectedCamera) {
      return config.cameras[selectedCamera];
    }
  }, [config, selectedCamera]);

  // the preview is only drawn while a slider is actively being driven, so it
  // never sits over the image while the scene is being watched. pointer and
  // keyboard are tracked separately: a click leaves the thumb focused, and
  // treating that as "still tuning" would keep the preview up after release
  const [pointerControl, setPointerControl] = useState<TunedControl | null>(
    null,
  );
  const [focusControl, setFocusControl] = useState<TunedControl | null>(null);
  const tunedControl = pointerControl ?? focusControl;

  useEffect(() => {
    if (!pointerControl) return;

    // release can land outside the slider, so listen on the window rather than
    // relying on the slider seeing the matching pointerup
    const clear = () => setPointerControl(null);
    window.addEventListener("pointerup", clear);
    window.addEventListener("pointercancel", clear);

    return () => {
      window.removeEventListener("pointerup", clear);
      window.removeEventListener("pointercancel", clear);
    };
  }, [pointerControl]);

  const sliderPreviewProps = useCallback(
    (control: TunedControl) => ({
      onPointerDown: () => setPointerControl(control),
      onFocus: (event: React.FocusEvent<HTMLElement>) => {
        // only keyboard focus, otherwise a click would show the preview twice
        // over and keep it up once the pointer is released
        if (event.target.matches(":focus-visible")) {
          setFocusControl(control);
        }
      },
      onBlur: () => setFocusControl(null),
    }),
    [],
  );

  const previewContainerRef = useRef<HTMLDivElement | null>(null);
  const [{ width: previewWidth, height: previewHeight }] =
    useResizeObserver(previewContainerRef);

  // where the camera frame actually lands inside its container. CameraImage top
  // aligns the frame and only centers it horizontally, so this is an
  // object-contain fit with the vertical offset held at zero
  const frameRect = useMemo(() => {
    if (!cameraConfig || !previewWidth || !previewHeight) {
      return undefined;
    }

    const aspect = cameraConfig.detect.width / cameraConfig.detect.height;

    if (previewWidth / previewHeight > aspect) {
      const height = previewHeight;
      const width = height * aspect;
      return { left: (previewWidth - width) / 2, width, height };
    }

    return { left: 0, width: previewWidth, height: previewWidth / aspect };
  }, [cameraConfig, previewWidth, previewHeight]);

  // contour_area is measured on the downscaled motion frame, which shares the
  // camera's aspect ratio. a square of that area therefore has a side of
  // sqrt(area) / frame_height as a fraction of frame height, at any resolution
  const previewSizePercent = useMemo(() => {
    const frameHeight =
      // mirrors improved_motion.py, which falls back to the full detect height
      // when frame_height is unset. `||` rather than `??` so that 0 falls back
      // the same way Python's `or` does
      cameraConfig?.motion?.frame_height || cameraConfig?.detect?.height;

    if (!motionSettings.contour_area || !frameHeight) {
      return undefined;
    }

    return (Math.sqrt(motionSettings.contour_area) / frameHeight) * 100;
  }, [motionSettings.contour_area, cameraConfig]);

  useEffect(() => {
    userInteractedRef.current = false;
    if (cameraConfig) {
      setMotionSettings({
        threshold: cameraConfig.motion.threshold,
        contour_area: cameraConfig.motion.contour_area,
        improve_contrast: cameraConfig.motion.improve_contrast,
      });
      setOrigMotionSettings({
        threshold: cameraConfig.motion.threshold,
        contour_area: cameraConfig.motion.contour_area,
        improve_contrast: cameraConfig.motion.improve_contrast,
      });
    }
    // we know that these deps are correct
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCamera]);

  useEffect(() => {
    if (!motionSettings.threshold || !userInteractedRef.current) return;

    sendMotionThreshold(motionSettings.threshold);
  }, [motionSettings.threshold, sendMotionThreshold]);

  useEffect(() => {
    if (!motionSettings.contour_area || !userInteractedRef.current) return;

    sendMotionContourArea(motionSettings.contour_area);
  }, [motionSettings.contour_area, sendMotionContourArea]);

  useEffect(() => {
    if (
      motionSettings.improve_contrast === undefined ||
      !userInteractedRef.current
    )
      return;

    sendImproveContrast(motionSettings.improve_contrast ? "ON" : "OFF");
  }, [motionSettings.improve_contrast, sendImproveContrast]);

  const handleMotionConfigChange = (newConfig: Partial<MotionSettings>) => {
    userInteractedRef.current = true;
    setMotionSettings((prevConfig) => ({ ...prevConfig, ...newConfig }));
    setUnsavedChanges(true);
    setChangedValue(true);
  };

  const saveToConfig = useCallback(async () => {
    setIsLoading(true);

    axios
      .put(
        `config/set?cameras.${selectedCamera}.motion.threshold=${motionSettings.threshold}&cameras.${selectedCamera}.motion.contour_area=${motionSettings.contour_area}&cameras.${selectedCamera}.motion.improve_contrast=${motionSettings.improve_contrast ? "True" : "False"}`,
        {
          requires_restart: 0,
          update_topic: `config/cameras/${selectedCamera}/motion`,
        },
      )
      .then((res) => {
        if (res.status === 200) {
          toast.success(t("motionDetectionTuner.toast.success"), {
            position: "top-center",
          });
          setChangedValue(false);
          updateConfig();
        } else {
          toast.error(
            t("toast.save.error.title", {
              errorMessage: res.statusText,
              ns: "common",
            }),
            {
              position: "top-center",
            },
          );
        }
      })
      .catch((error) => {
        toast.error(
          t("toast.save.error.title", {
            errorMessage: error.response.data.message,
            ns: "common",
          }),
          { position: "top-center" },
        );
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [
    updateConfig,
    motionSettings.threshold,
    motionSettings.contour_area,
    motionSettings.improve_contrast,
    selectedCamera,
    t,
  ]);

  const onCancel = useCallback(() => {
    setMotionSettings(origMotionSettings);
    setChangedValue(false);
  }, [origMotionSettings]);

  useEffect(() => {
    document.title = t("documentTitle.motionTuner");
  }, [t]);

  if (!cameraConfig && !selectedCamera) {
    return <ActivityIndicator />;
  }

  return (
    <div className="flex size-full flex-col md:flex-row">
      <div className="scrollbar-container order-last mb-2 mt-2 flex h-full w-full flex-col overflow-y-auto rounded-lg border-[1px] border-secondary-foreground bg-background_alt p-2 md:order-none md:mr-3 md:mt-0 md:w-3/12">
        <Heading as="h4" className="mb-2">
          {t("motionDetectionTuner.title")}
        </Heading>
        <div className="my-3 space-y-3 text-sm text-muted-foreground">
          <p>{t("motionDetectionTuner.desc.title")}</p>

          <div className="flex items-center text-primary">
            <Link
              to={getLocaleDocUrl("configuration/motion_detection")}
              target="_blank"
              rel="noopener noreferrer"
              className="inline"
            >
              {t("readTheDocumentation", { ns: "common" })}
              <LuExternalLink className="ml-2 inline-flex size-3" />
            </Link>
          </div>
        </div>
        <Separator className="my-2 flex bg-secondary" />
        <div className="flex w-full flex-col space-y-6">
          <div className="mt-2 space-y-6">
            <div className="space-y-0.5">
              <Label htmlFor="motion-threshold">
                {t("motionDetectionTuner.Threshold.title")}
              </Label>
              <div className="my-2 text-sm text-muted-foreground">
                <Trans ns="views/settings">
                  motionDetectionTuner.Threshold.desc
                </Trans>
              </div>
            </div>
            <div className="flex flex-row justify-between">
              <Slider
                id="motion-threshold"
                className="w-full"
                disabled={motionSettings.threshold === undefined}
                value={[motionSettings.threshold ?? 0]}
                min={5}
                max={80}
                step={1}
                onValueChange={(value) => {
                  handleMotionConfigChange({ threshold: value[0] });
                }}
                {...sliderPreviewProps("threshold")}
              />
              <div className="align-center ml-6 mr-2 flex text-lg">
                {motionSettings.threshold}
              </div>
            </div>
          </div>
          <div className="mt-2 space-y-6">
            <div className="space-y-0.5">
              <Label htmlFor="motion-threshold">
                {t("motionDetectionTuner.contourArea.title")}
              </Label>
              <div className="my-2 text-sm text-muted-foreground">
                <p>
                  <Trans ns="views/settings">
                    motionDetectionTuner.contourArea.desc
                  </Trans>
                </p>
              </div>
            </div>
            <div className="flex flex-row justify-between">
              <Slider
                id="motion-contour-area"
                className="w-full"
                disabled={motionSettings.contour_area === undefined}
                value={[motionSettings.contour_area ?? 0]}
                min={5}
                max={100}
                step={1}
                onValueChange={(value) => {
                  handleMotionConfigChange({ contour_area: value[0] });
                }}
                {...sliderPreviewProps("contourArea")}
              />
              <div className="align-center ml-6 mr-2 flex text-lg">
                {motionSettings.contour_area}
              </div>
            </div>
          </div>
          <Separator className="my-2 flex bg-secondary" />
          <div className="flex flex-row items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="improve-contrast">
                {t("motionDetectionTuner.improveContrast.title")}
              </Label>
              <div className="text-sm text-muted-foreground">
                <Trans ns="views/settings">
                  motionDetectionTuner.improveContrast.desc
                </Trans>
              </div>
            </div>
            <Switch
              id="improve-contrast"
              className="ml-3"
              disabled={motionSettings.improve_contrast === undefined}
              checked={motionSettings.improve_contrast === true}
              onCheckedChange={(isChecked) => {
                handleMotionConfigChange({ improve_contrast: isChecked });
              }}
            />
          </div>
        </div>
        <div className="flex flex-1 flex-col justify-end">
          <div className="flex flex-row gap-2 pt-5">
            <Button
              className="flex flex-1"
              aria-label={t("button.reset", { ns: "common" })}
              onClick={onCancel}
            >
              {t("button.reset", { ns: "common" })}
            </Button>
            <Button
              variant="select"
              disabled={!changedValue || isLoading}
              className="flex flex-1"
              aria-label={t("button.save", { ns: "common" })}
              onClick={saveToConfig}
            >
              {isLoading ? (
                <div className="flex flex-row items-center gap-2">
                  <ActivityIndicator className="size-4" />
                  <span>{t("button.saving", { ns: "common" })}</span>
                </div>
              ) : (
                t("button.save", { ns: "common" })
              )}
            </Button>
          </div>
        </div>
      </div>

      {cameraConfig ? (
        <div
          className={cn(
            "flex max-h-[70%] md:h-dvh md:max-h-full md:w-7/12 md:grow",
            isDesktop && "md:mr-3",
          )}
        >
          <div
            className="relative size-full min-h-10"
            ref={previewContainerRef}
          >
            <AutoUpdatingCameraImage
              camera={cameraConfig.name}
              searchParams={new URLSearchParams([["motion", "1"]])}
              showFps={false}
              className="size-full"
              cameraClasses="relative w-full h-full flex flex-col justify-start"
            />
            {tunedControl && frameRect && previewSizePercent !== undefined ? (
              <div
                className="pointer-events-none absolute top-0 flex flex-col items-center justify-center gap-2"
                style={{
                  left: frameRect.left,
                  width: frameRect.width,
                  height: frameRect.height,
                }}
              >
                <div
                  className="relative border-2 border-dashed border-sky-400"
                  style={{
                    height: `${previewSizePercent}%`,
                    aspectRatio: "1",
                  }}
                >
                  {/* plus-lighter adds the threshold to each channel, so the
                      patch brightens by exactly that many levels whatever it
                      covers. plain opacity would scale with the pixel
                      underneath and understate the change in dark areas */}
                  <div
                    className="absolute inset-0 animate-motion-strobe motion-reduce:strobe-static"
                    style={{
                      backgroundColor: `rgb(${motionSettings.threshold ?? 0}, ${motionSettings.threshold ?? 0}, ${motionSettings.threshold ?? 0})`,
                      mixBlendMode: "plus-lighter",
                    }}
                  />
                </div>
                <div className="max-w-[min(20rem,90%)] rounded-lg bg-background/80 p-2 text-center">
                  <div className="text-sm font-medium text-primary">
                    {t("motionDetectionTuner.preview.title")}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {t("motionDetectionTuner.preview.desc")}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {t("motionDetectionTuner.preview.resolutionNote")}
                  </div>
                  {motionSettings.improve_contrast ? (
                    <div className="mt-1 text-xs text-muted-foreground">
                      {t("motionDetectionTuner.preview.contrastCaveat")}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <Skeleton className="size-full rounded-lg md:rounded-2xl" />
      )}
    </div>
  );
}
