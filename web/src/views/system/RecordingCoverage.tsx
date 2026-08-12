import { useMemo, useState } from "react";
import useSWR from "swr";
import { useTranslation } from "react-i18next";
import { TZDate } from "react-day-picker";
import { CiCircleAlert } from "react-icons/ci";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import ActivityIndicator from "@/components/indicators/activity-indicator";
import { CameraConfig, FrigateConfig } from "@/types/frigateConfig";
import { RecordingsSummaryDay } from "@/types/review";
import { useTimezone } from "@/hooks/use-date-utils";
import { cn } from "@/lib/utils";

const RANGE_OPTIONS = [7, 14, 30] as const;
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const SECONDS_PER_HOUR = 3600;
// fixed cell columns: stretched to the full width of a desktop card the row
// stops reading as a heatmap and starts reading as a bar chart
const GRID_COLUMNS = "repeat(24, 18px)";

// a cell is either fully covered, missing some fraction of its hour, or not
// part of the window we can judge at all
type CellStatus =
  | "complete"
  | "loss"
  | "outside"
  | "inProgress"
  // no footage kept, on a camera where that is expected rather than a fault
  | "empty";

type Cell = {
  dayKey: string;
  hour: number;
  status: CellStatus;
  /** fraction of the hour with no recording, 0 to 1 */
  missing: number;
  /** ramp step 1-4, or 0 when nothing is missing */
  bin: number;
};

/**
 * Map a missing fraction onto the four ordinal ramp steps.
 *
 * The lowest band is deliberately narrow: at the default ten second segment
 * length a single lost segment is only 0.28% of an hour, so anything at or
 * above 1% is already several segments gone rather than a rounding artifact.
 */
function lossBin(missing: number): number {
  if (missing < 0.0025) return 0;
  if (missing < 0.01) return 1;
  if (missing < 0.1) return 2;
  if (missing < 0.5) return 3;
  return 4;
}

function binColor(bin: number): string | undefined {
  return bin === 0 ? undefined : `var(--coverage-loss-${bin})`;
}

function pad2(value: number): string {
  return value.toString().padStart(2, "0");
}

/** Format a duration in seconds as a compact human string. */
function formatMissing(seconds: number): string {
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;

  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}

type RecordingCoverageProps = {
  cameras: CameraConfig[];
};

export default function RecordingCoverage({ cameras }: RecordingCoverageProps) {
  const { t } = useTranslation(["views/system"]);
  const { data: config } = useSWR<FrigateConfig>("config", {
    revalidateOnFocus: false,
  });
  const configTimezone = useTimezone(config);
  // the hook only returns undefined before the config lands; fall back to the
  // browser zone so the grid's day boundaries never silently become UTC
  const timezone =
    configTimezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const [rangeDays, setRangeDays] = useState<number>(14);

  const recordingCameras = useMemo(
    () => cameras.filter((cam) => cam.enabled && cam.record.enabled),
    [cameras],
  );

  return (
    <div className="mt-4">
      <div className="flex flex-row items-center justify-between">
        <div className="flex flex-row items-center gap-2 text-sm font-medium text-muted-foreground">
          {t("storage.coverage.title")}
          <Popover>
            <PopoverTrigger asChild>
              <button
                className="focus:outline-none"
                aria-label={t("storage.coverage.title")}
              >
                <CiCircleAlert className="size-5" />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-80">
              <div className="space-y-2 text-sm">
                {t("storage.coverage.tips")}
              </div>
            </PopoverContent>
          </Popover>
        </div>
        <ToggleGroup
          type="single"
          size="sm"
          value={rangeDays.toString()}
          onValueChange={(value) => {
            if (value) setRangeDays(parseInt(value));
          }}
          aria-label={t("storage.coverage.range.label")}
        >
          {RANGE_OPTIONS.map((option) => (
            <ToggleGroupItem
              key={option}
              value={option.toString()}
              aria-label={t("storage.coverage.range.option", { days: option })}
            >
              {t("storage.coverage.range.option", { days: option })}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <CoverageLegend />

      {recordingCameras.length === 0 ? (
        <div className="mt-4 rounded-lg bg-background_alt p-4 text-sm text-muted-foreground md:rounded-2xl">
          {t("storage.coverage.noCameras")}
        </div>
      ) : (
        <div className="mt-2 flex flex-col gap-2">
          {recordingCameras.map((camera) => (
            <CameraCoverageCard
              key={camera.name}
              camera={camera}
              rangeDays={rangeDays}
              timezone={timezone}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function CoverageLegend() {
  const { t } = useTranslation(["views/system"]);

  const steps = [
    { key: "none", color: undefined },
    { key: "under1", color: binColor(1) },
    { key: "under10", color: binColor(2) },
    { key: "under50", color: binColor(3) },
    { key: "over50", color: binColor(4) },
  ];

  return (
    <div className="mt-2 flex flex-row flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <span>{t("storage.coverage.legend.label")}</span>
      {steps.map((step) => (
        <span key={step.key} className="flex flex-row items-center gap-1.5">
          <span
            className={cn(
              "size-3 rounded-[2px]",
              step.color == undefined && "bg-secondary",
            )}
            style={step.color ? { backgroundColor: step.color } : undefined}
          />
          {t(`storage.coverage.legend.${step.key}`)}
        </span>
      ))}
      <span className="flex flex-row items-center gap-1.5">
        <span className="size-3 rounded-[2px] bg-slashes" />
        {t("storage.coverage.legend.outside")}
      </span>
    </div>
  );
}

type CameraCoverageCardProps = {
  camera: CameraConfig;
  rangeDays: number;
  timezone: string;
};

function CameraCoverageCard({
  camera,
  rangeDays,
  timezone,
}: CameraCoverageCardProps) {
  const { t } = useTranslation(["views/system"]);
  const [hovered, setHovered] = useState<Cell | undefined>();

  const { data: summary } = useSWR<RecordingsSummaryDay[]>([
    `${camera.name}/recordings/summary`,
    { timezone },
  ]);

  // continuous retention is what makes a coverage percentage meaningful: with
  // it off, an empty hour means nothing moved rather than something broke
  const continuousDays = camera.record.continuous?.days ?? 0;
  const isContinuous = continuousDays > 0;

  const model = useMemo(() => {
    if (!summary) return undefined;

    // seconds of footage kept, keyed by "<day> <hour>"
    const kept = new Map<string, number>();
    let earliestKeptMs: number | undefined;

    for (const day of summary) {
      for (const entry of day.hours) {
        const hour = parseInt(entry.hour);
        const key = `${day.day} ${hour}`;
        kept.set(key, (kept.get(key) ?? 0) + (entry.duration ?? 0));

        if ((entry.duration ?? 0) > 0) {
          const startMs = new TZDate(
            `${day.day}T${pad2(hour)}:00:00`,
            timezone,
          ).getTime();
          if (earliestKeptMs == undefined || startMs < earliestKeptMs) {
            earliestKeptMs = startMs;
          }
        }
      }
    }

    if (earliestKeptMs == undefined) return undefined;

    const nowMs = Date.now();
    const nowLocal = new TZDate(new Date(), timezone);
    const todayKey = `${nowLocal.getFullYear()}-${pad2(
      nowLocal.getMonth() + 1,
    )}-${pad2(nowLocal.getDate())}`;

    // Calendar labels only, so plain UTC arithmetic is exact here and cannot
    // be knocked off by a DST transition in the display timezone.
    const todayUtc = new Date(`${todayKey}T00:00:00Z`).getTime();

    // The window we can fairly judge starts at whichever is later: the rolling
    // continuous retention cutoff, or the first footage this camera ever kept.
    // Without the second clamp a camera added yesterday would read as weeks of
    // total loss.
    const retentionStartMs = isContinuous
      ? nowMs - continuousDays * 86400000
      : -Infinity;
    const windowStartMs = Math.max(retentionStartMs, earliestKeptMs);

    const rows: { dayKey: string; cells: Cell[] }[] = [];
    let countedSeconds = 0;
    let missingSeconds = 0;
    let affectedHours = 0;
    const hourTotals = HOURS.map(() => ({ counted: 0, missing: 0 }));

    for (let i = 0; i < rangeDays; i++) {
      const dayKey = new Date(todayUtc - i * 86400000)
        .toISOString()
        .slice(0, 10);
      const cells: Cell[] = [];

      for (const hour of HOURS) {
        const startMs = new TZDate(
          `${dayKey}T${pad2(hour)}:00:00`,
          timezone,
        ).getTime();
        const endMs = startMs + SECONDS_PER_HOUR * 1000;
        const duration = kept.get(`${dayKey} ${hour}`) ?? 0;

        // an hour that has not finished yet is legitimately partial, and one
        // outside the window is not ours to judge
        if (startMs >= nowMs || startMs < windowStartMs) {
          cells.push({ dayKey, hour, status: "outside", missing: 0, bin: 0 });
          continue;
        }

        if (endMs > nowMs) {
          cells.push({
            dayKey,
            hour,
            status: "inProgress",
            missing: 0,
            bin: 0,
          });
          continue;
        }

        // overlapping segments could in principle sum past the hour
        const covered = Math.min(1, duration / SECONDS_PER_HOUR);

        // without continuous retention an empty hour is the expected outcome,
        // so the grid reports whether footage was kept rather than scoring it
        if (!isContinuous) {
          cells.push({
            dayKey,
            hour,
            status: covered > 0 ? "complete" : "empty",
            missing: 0,
            bin: 0,
          });
          continue;
        }

        const missing = 1 - covered;
        const bin = lossBin(missing);

        countedSeconds += SECONDS_PER_HOUR;
        missingSeconds += missing * SECONDS_PER_HOUR;
        hourTotals[hour].counted += SECONDS_PER_HOUR;
        hourTotals[hour].missing += missing * SECONDS_PER_HOUR;
        if (bin > 0) affectedHours += 1;

        cells.push({
          dayKey,
          hour,
          status: bin > 0 ? "loss" : "complete",
          missing,
          bin: Math.max(0, bin),
        });
      }

      rows.push({ dayKey, cells });
    }

    const profile = hourTotals.map((total) =>
      total.counted === 0 ? undefined : total.missing / total.counted,
    );

    return {
      rows,
      profile,
      coverage:
        countedSeconds === 0 ? undefined : 1 - missingSeconds / countedSeconds,
      missingSeconds,
      affectedHours,
      retainedFromMs: windowStartMs,
    };
  }, [summary, timezone, rangeDays, isContinuous, continuousDays]);

  const readout = useMemo(() => {
    if (!hovered) return undefined;

    const date = new TZDate(`${hovered.dayKey}T00:00:00`, timezone);
    const label = date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
    const hour = `${pad2(hovered.hour)}:00`;

    if (hovered.status === "outside") {
      return t("storage.coverage.cell.outside", { date: label, hour });
    }
    if (hovered.status === "inProgress") {
      return t("storage.coverage.cell.inProgress", { date: label, hour });
    }
    if (hovered.status === "complete") {
      return t("storage.coverage.cell.complete", { date: label, hour });
    }
    if (hovered.status === "empty") {
      return t("storage.coverage.cell.empty", { date: label, hour });
    }
    return t("storage.coverage.cell.loss", {
      date: label,
      hour,
      percent: ((1 - hovered.missing) * 100).toFixed(1),
      missing: formatMissing(hovered.missing * SECONDS_PER_HOUR),
    });
  }, [hovered, timezone, t]);

  return (
    <div className="flex-col rounded-lg bg-background_alt p-2.5 md:rounded-2xl">
      <div className="flex flex-row flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="font-medium smart-capitalize">
          {camera.name.replaceAll("_", " ")}
        </div>
        <div className="text-xs text-muted-foreground">
          {readout ?? (model ? t("storage.coverage.hint") : "")}
        </div>
      </div>

      {!summary ? (
        <div className="flex h-24 items-center justify-center">
          <ActivityIndicator />
        </div>
      ) : !model ? (
        <div className="py-4 text-sm text-muted-foreground">
          {t("storage.coverage.empty")}
        </div>
      ) : (
        <>
          {isContinuous ? (
            <CoverageHeadline
              coverage={model.coverage}
              missingSeconds={model.missingSeconds}
              affectedHours={model.affectedHours}
            />
          ) : (
            <div className="mt-2 rounded-md bg-background p-2 text-xs text-muted-foreground">
              <span className="font-medium text-primary-variant">
                {t("storage.coverage.eventOnly.title")}
              </span>{" "}
              {t("storage.coverage.eventOnly.description")}
            </div>
          )}

          <CoverageGrid
            rows={model.rows}
            timezone={timezone}
            onHover={setHovered}
          />

          <HourProfile profile={model.profile} />
        </>
      )}
    </div>
  );
}

type CoverageHeadlineProps = {
  coverage: number | undefined;
  missingSeconds: number;
  affectedHours: number;
};

function CoverageHeadline({
  coverage,
  missingSeconds,
  affectedHours,
}: CoverageHeadlineProps) {
  const { t } = useTranslation(["views/system"]);

  if (coverage == undefined) return null;

  return (
    <div className="mt-2 flex flex-row flex-wrap items-baseline gap-x-6 gap-y-1">
      <div className="flex flex-row items-baseline gap-1.5">
        <span className="text-2xl font-medium tabular-nums">
          {(coverage * 100).toFixed(coverage > 0.9995 ? 0 : 1)}%
        </span>
        <span className="text-xs text-muted-foreground">
          {t("storage.coverage.coverage")}
        </span>
      </div>
      <div className="text-xs text-muted-foreground">
        {missingSeconds < 1
          ? t("storage.coverage.complete")
          : `${formatMissing(missingSeconds)} ${t(
              "storage.coverage.missing",
            ).toLowerCase()} · ${t("storage.coverage.affectedHours", {
              count: affectedHours,
            })}`}
      </div>
    </div>
  );
}

type CoverageGridProps = {
  rows: { dayKey: string; cells: Cell[] }[];
  timezone: string;
  onHover: (cell: Cell | undefined) => void;
};

function CoverageGrid({ rows, timezone, onHover }: CoverageGridProps) {
  return (
    <div
      className="mt-3 overflow-x-auto"
      onMouseLeave={() => onHover(undefined)}
    >
      <div className="w-fit">
        <div className="flex flex-row items-center gap-1">
          <div className="w-12 shrink-0" />
          <div
            className="grid shrink-0 gap-[2px] text-[10px] text-muted-foreground"
            style={{ gridTemplateColumns: GRID_COLUMNS }}
          >
            {HOURS.map((hour) => (
              <div key={hour} className="text-center">
                {hour % 6 === 0 ? pad2(hour) : ""}
              </div>
            ))}
          </div>
        </div>

        {rows.map((row) => (
          <div key={row.dayKey} className="flex flex-row items-center gap-1">
            <div className="w-12 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
              {new TZDate(
                `${row.dayKey}T00:00:00`,
                timezone,
              ).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
              })}
            </div>
            <div
              className="grid shrink-0 gap-[2px] py-[1px]"
              style={{ gridTemplateColumns: GRID_COLUMNS }}
            >
              {row.cells.map((cell) => (
                <CoverageCell
                  key={cell.hour}
                  cell={cell}
                  timezone={timezone}
                  onHover={onHover}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

type CoverageCellProps = {
  cell: Cell;
  timezone: string;
  onHover: (cell: Cell | undefined) => void;
};

function CoverageCell({ cell, timezone, onHover }: CoverageCellProps) {
  const { t } = useTranslation(["views/system"]);

  const label = useMemo(() => {
    const date = new TZDate(
      `${cell.dayKey}T00:00:00`,
      timezone,
    ).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const hour = `${pad2(cell.hour)}:00`;

    switch (cell.status) {
      case "outside":
        return t("storage.coverage.cell.outside", { date, hour });
      case "inProgress":
        return t("storage.coverage.cell.inProgress", { date, hour });
      case "complete":
        return t("storage.coverage.cell.complete", { date, hour });
      case "empty":
        return t("storage.coverage.cell.empty", { date, hour });
      default:
        return t("storage.coverage.cell.loss", {
          date,
          hour,
          percent: ((1 - cell.missing) * 100).toFixed(1),
          missing: formatMissing(cell.missing * SECONDS_PER_HOUR),
        });
    }
  }, [cell, timezone, t]);

  const color = binColor(cell.bin);

  return (
    <div
      title={label}
      aria-label={label}
      onMouseEnter={() => onHover(cell)}
      onFocus={() => onHover(cell)}
      tabIndex={-1}
      className={cn(
        "h-4 rounded-[2px]",
        cell.status === "outside" && "bg-slashes opacity-30",
        cell.status === "inProgress" && "bg-secondary opacity-50",
        cell.status === "complete" && "bg-secondary",
        // an outline rather than a fill, so sparse event footage reads as marks
        // on an empty ground instead of a solid block
        cell.status === "empty" && "border border-secondary",
      )}
      style={color ? { backgroundColor: color } : undefined}
    />
  );
}

type HourProfileProps = {
  profile: (number | undefined)[];
};

function HourProfile({ profile }: HourProfileProps) {
  const { t } = useTranslation(["views/system"]);

  const hasData = profile.some((value) => value != undefined);
  if (!hasData) return null;

  return (
    <div className="mt-3">
      <div className="flex flex-row items-center gap-1">
        <div className="w-12 shrink-0 text-right text-[10px] text-muted-foreground">
          {t("storage.coverage.profile.title")}
        </div>
        <div
          className="grid shrink-0 gap-[2px]"
          style={{ gridTemplateColumns: GRID_COLUMNS }}
        >
          {profile.map((missing, hour) => {
            const bin = missing == undefined ? 0 : lossBin(missing);
            const color = binColor(bin);
            const label =
              missing == undefined
                ? `${pad2(hour)}:00`
                : `${pad2(hour)}:00 · ${((1 - missing) * 100).toFixed(1)}%`;

            return (
              <div
                key={hour}
                title={label}
                aria-label={label}
                className={cn(
                  "h-2 rounded-[2px]",
                  missing == undefined
                    ? "bg-slashes opacity-30"
                    : color == undefined && "bg-secondary",
                )}
                style={color ? { backgroundColor: color } : undefined}
              />
            );
          })}
        </div>
      </div>
      <div className="ml-[52px] mt-1 text-[10px] text-muted-foreground">
        {t("storage.coverage.profile.description")}
      </div>
    </div>
  );
}
