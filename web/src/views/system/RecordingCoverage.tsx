import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import { useTranslation } from "react-i18next";
import { TZDate } from "react-day-picker";
import { CiCircleAlert } from "react-icons/ci";
import { LuChevronRight } from "react-icons/lu";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import ActivityIndicator from "@/components/indicators/activity-indicator";
import { useNavigate } from "react-router-dom";
import { CameraConfig, FrigateConfig } from "@/types/frigateConfig";
import { RecordingGap, RecordingsSummaryDay } from "@/types/review";
import { RecordingStartingPoint } from "@/types/record";
import { use24HourTime, useTimezone } from "@/hooks/use-date-utils";
import { useDateLocale } from "@/hooks/use-date-locale";
import { formatUnixTimestampToDateTime } from "@/utils/dateUtil";
import { cn } from "@/lib/utils";

const RANGE_OPTIONS = [7, 14, 30] as const;
const HOURS = Array.from({ length: 24 }, (_, i) => i);
const SECONDS_PER_HOUR = 3600;
// fixed cell columns: stretched to the full width of a desktop card the row
// stops reading as a heatmap and starts reading as a bar chart
const GRID_COLUMNS = "repeat(24, minmax(0, 1fr))";

// a cell is either fully covered, missing some fraction of its hour, or not
// part of the window we can judge at all
type CellStatus =
  | "complete"
  | "loss"
  | "outside"
  | "inProgress"
  // no footage kept, on a camera where that is expected rather than a fault
  | "empty";

/** One recorded cause, totalled across the window. */
type Cause = {
  reason: string;
  /** seconds of loss booked against this cause */
  seconds: number;
  /** evidence from the most recent incident, such as the ffmpeg error */
  detail?: string | null;
  /** end time of the newest incident, used to pick which detail to keep */
  latest: number;
};

type Cell = {
  dayKey: string;
  hour: number;
  status: CellStatus;
  /** fraction of the hour with no recording, 0 to 1 */
  missing: number;
  /** ramp step 1-4, or 0 when nothing is missing */
  bin: number;
  /** causes Frigate recorded for this hour, worst first */
  reasons: string[];
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
/**
 * Render a gap length.
 *
 * Unlike the card totals this keeps seconds, because a gap is something you
 * go and look at: rounding a 52 second hole to "1m" makes it harder to find.
 */
function formatGapLength(seconds: number): string {
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;

  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

function formatMissing(seconds: number): string {
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;

  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`;
}

/** Name the recorded causes for an hour, or say plainly that none were. */
function useReasonText() {
  const { t } = useTranslation(["views/system"]);

  return useCallback(
    (reasons: string[]) =>
      reasons.length === 0
        ? t("coverage.unexplained")
        : reasons.map((reason) => t(`coverage.reason.${reason}`)).join(", "),
    [t],
  );
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
    <div className="scrollbar-container mt-4 flex size-full flex-col overflow-y-auto">
      <div className="flex flex-row items-center justify-between">
        <div className="flex flex-row items-center gap-2 text-sm font-medium text-muted-foreground">
          {t("coverage.heading")}
          <Popover>
            <PopoverTrigger asChild>
              <button
                className="focus:outline-none"
                aria-label={t("coverage.heading")}
              >
                <CiCircleAlert className="size-5" />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-80">
              <div className="space-y-2 text-sm">{t("coverage.tips")}</div>
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
          aria-label={t("coverage.range.label")}
        >
          {RANGE_OPTIONS.map((option) => (
            <ToggleGroupItem
              key={option}
              value={option.toString()}
              aria-label={t("coverage.range.option", { days: option })}
            >
              {t("coverage.range.option", { days: option })}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      <CoverageLegend />

      {recordingCameras.length === 0 ? (
        <div className="mt-4 rounded-lg bg-background_alt p-4 text-sm text-muted-foreground md:rounded-2xl">
          {t("coverage.noCameras")}
        </div>
      ) : (
        <div className="mt-2 grid grid-cols-1 gap-2 xl:grid-cols-2 3xl:grid-cols-3">
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
      <span>{t("coverage.legend.label")}</span>
      {steps.map((step) => (
        <span key={step.key} className="flex flex-row items-center gap-1.5">
          <span
            className={cn(
              "size-3 rounded-[2px]",
              step.color == undefined && "bg-secondary",
            )}
            style={step.color ? { backgroundColor: step.color } : undefined}
          />
          {t(`coverage.legend.${step.key}`)}
        </span>
      ))}
      <span className="flex flex-row items-center gap-1.5">
        <span className="size-3 rounded-[2px] bg-slashes" />
        {t("coverage.legend.outside")}
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
  const reasonText = useReasonText();
  const [hovered, setHovered] = useState<Cell | undefined>();

  const { data: summary } = useSWR<RecordingsSummaryDay[]>([
    `${camera.name}/recordings/summary`,
    { timezone },
  ]);

  // the window the grid can show, used to bound the gap query
  const gapWindow = useMemo(() => {
    const before = Date.now() / 1000;
    return { after: before - rangeDays * 86400, before };
  }, [rangeDays]);

  const { data: gaps } = useSWR<RecordingGap[]>([
    "recordings/gaps",
    {
      cameras: camera.name,
      after: Math.floor(gapWindow.after),
      before: Math.ceil(gapWindow.before),
    },
  ]);

  // continuous retention is what makes a coverage percentage meaningful: with
  // it off, an empty hour means nothing moved rather than something broke
  const continuousDays = camera.record.continuous?.days ?? 0;
  const isContinuous = continuousDays > 0;

  // a gap spans a range, so book it against every hour it touches
  const reasonsByHour = useMemo(() => {
    const byHour = new Map<number, Map<string, number>>();

    for (const gap of gaps ?? []) {
      const firstHour = Math.floor(gap.start_time / SECONDS_PER_HOUR);
      const lastHour = Math.floor((gap.end_time - 0.001) / SECONDS_PER_HOUR);

      for (let hour = firstHour; hour <= lastHour; hour++) {
        const hourStart = hour * SECONDS_PER_HOUR;
        const overlap =
          Math.min(gap.end_time, hourStart + SECONDS_PER_HOUR) -
          Math.max(gap.start_time, hourStart);

        if (overlap <= 0) continue;

        const causes = byHour.get(hour) ?? new Map<string, number>();
        causes.set(gap.reason, (causes.get(gap.reason) ?? 0) + overlap);
        byHour.set(hour, causes);
      }
    }

    return byHour;
  }, [gaps]);

  // what actually caused the loss across the whole window, worst first
  const causeTotals = useMemo(() => {
    const totals = new Map<string, Cause>();

    for (const gap of gaps ?? []) {
      const start = Math.max(gap.start_time, gapWindow.after);
      const end = Math.min(gap.end_time, gapWindow.before);

      if (end <= start) continue;

      const existing = totals.get(gap.reason);

      // carry the newest evidence, which is the one still worth chasing
      const newest = existing === undefined || gap.end_time >= existing.latest;

      totals.set(gap.reason, {
        reason: gap.reason,
        seconds: (existing?.seconds ?? 0) + (end - start),
        detail: newest ? (gap.detail ?? existing?.detail) : existing?.detail,
        latest: Math.max(existing?.latest ?? 0, gap.end_time),
      });
    }

    return [...totals.values()].sort((a, b) => b.seconds - a.seconds);
  }, [gaps, gapWindow]);

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
          cells.push({
            dayKey,
            hour,
            status: "outside",
            missing: 0,
            bin: 0,
            reasons: [],
          });
          continue;
        }

        if (endMs > nowMs) {
          cells.push({
            dayKey,
            hour,
            status: "inProgress",
            missing: 0,
            bin: 0,
            reasons: [],
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
            reasons: [],
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

        const causes = reasonsByHour.get(Math.floor(startMs / 1000 / 3600));
        const reasons = causes
          ? [...causes.entries()]
              .sort((a, b) => b[1] - a[1])
              .map(([reason]) => reason)
          : [];

        cells.push({
          dayKey,
          hour,
          reasons: bin > 0 ? reasons : [],
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
  }, [
    summary,
    timezone,
    rangeDays,
    isContinuous,
    continuousDays,
    reasonsByHour,
  ]);

  const readout = useMemo(() => {
    if (!hovered) return undefined;

    const date = new TZDate(`${hovered.dayKey}T00:00:00`, timezone);
    const label = date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
    const hour = `${pad2(hovered.hour)}:00`;

    if (hovered.status === "outside") {
      return t("coverage.cell.outside", { date: label, hour });
    }
    if (hovered.status === "inProgress") {
      return t("coverage.cell.inProgress", { date: label, hour });
    }
    if (hovered.status === "complete") {
      return t("coverage.cell.complete", { date: label, hour });
    }
    if (hovered.status === "empty") {
      return t("coverage.cell.empty", { date: label, hour });
    }
    return `${t("coverage.cell.loss", {
      date: label,
      hour,
      percent: ((1 - hovered.missing) * 100).toFixed(1),
      missing: formatMissing(hovered.missing * SECONDS_PER_HOUR),
    })} (${reasonText(hovered.reasons)})`;
  }, [hovered, timezone, t, reasonText]);

  return (
    <div className="flex-col rounded-lg bg-background_alt p-2.5 md:rounded-2xl">
      <div className="flex flex-row flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="font-medium smart-capitalize">
          {camera.name.replaceAll("_", " ")}
        </div>
        <div className="text-xs text-muted-foreground">
          {readout ?? (model ? t("coverage.hint") : "")}
        </div>
      </div>

      {!summary ? (
        <div className="flex h-24 items-center justify-center">
          <ActivityIndicator />
        </div>
      ) : !model ? (
        <div className="py-4 text-sm text-muted-foreground">
          {t("coverage.empty")}
        </div>
      ) : (
        <>
          {isContinuous ? (
            <>
              <CoverageHeadline
                coverage={model.coverage}
                missingSeconds={model.missingSeconds}
                affectedHours={model.affectedHours}
              />
              <CauseBreakdown
                causes={causeTotals}
                missingSeconds={model.missingSeconds}
              />
            </>
          ) : (
            <div className="mt-2 rounded-md bg-background p-2 text-xs text-muted-foreground">
              <span className="font-medium text-primary-variant">
                {t("coverage.eventOnly.title")}
              </span>{" "}
              {t("coverage.eventOnly.description")}
            </div>
          )}

          <CoverageGrid
            rows={model.rows}
            timezone={timezone}
            onHover={setHovered}
          />

          <HourProfile profile={model.profile} />

          <GapIncidents gaps={gaps ?? []} camera={camera.name} />
        </>
      )}
    </div>
  );
}

// start playback a little before the loss: watching footage run into the hole
// is what separates a real gap from a seek that landed badly
const GAP_LEAD_SECONDS = 15;
const MAX_LISTED_GAPS = 10;

type GapIncidentsProps = {
  gaps: RecordingGap[];
  camera: string;
};

/**
 * List individual losses with the time they happened.
 *
 * The heatmap answers how much is missing, which is the wrong question when
 * you want to check whether it is really missing. That needs a timestamp
 * precise enough to seek to, so each row opens the recording at the moment
 * the footage stops.
 */
function GapIncidents({ gaps, camera }: GapIncidentsProps) {
  const { t } = useTranslation(["views/system", "common"]);
  const navigate = useNavigate();
  const { data: config } = useSWR<FrigateConfig>("config");
  const is24Hour = use24HourTime(config);
  const locale = useDateLocale();

  const recent = useMemo(
    () =>
      [...gaps]
        .sort((a, b) => b.start_time - a.start_time)
        .slice(0, MAX_LISTED_GAPS),
    [gaps],
  );

  const openTimeline = useCallback(
    (gap: RecordingGap) => {
      navigate("/review", {
        state: {
          recording: {
            camera,
            startTime: Math.max(0, gap.start_time - GAP_LEAD_SECONDS),
            severity: "alert",
          } satisfies RecordingStartingPoint,
        },
      });
    },
    [camera, navigate],
  );

  const formatWhen = useCallback(
    (timestamp: number) =>
      formatUnixTimestampToDateTime(timestamp, {
        timezone: config?.ui.timezone,
        date_format: t(
          `time.formattedTimestamp.${is24Hour ? "24hour" : "12hour"}`,
          { ns: "common" },
        ),
        locale,
      }),
    [config, is24Hour, locale, t],
  );

  if (recent.length === 0) return null;

  return (
    <div className="mt-3">
      <div className="flex flex-row items-baseline justify-between gap-2">
        <span className="text-xs font-medium text-primary-variant">
          {t("coverage.incidents.title")}
        </span>
        <span className="text-xs text-muted-foreground">
          {gaps.length > recent.length
            ? t("coverage.incidents.showing", {
                shown: recent.length,
                total: gaps.length,
              })
            : t("coverage.incidents.hint")}
        </span>
      </div>

      <div className="mt-1 flex flex-col">
        {recent.map((gap) => (
          <button
            key={gap.id}
            type="button"
            onClick={() => openTimeline(gap)}
            title={gap.detail ?? undefined}
            className="group flex cursor-pointer flex-row items-baseline gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-secondary"
          >
            <span className="shrink-0 tabular-nums text-primary">
              {formatWhen(gap.start_time)}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {formatGapLength(gap.end_time - gap.start_time)}
            </span>
            <span className="truncate text-muted-foreground">
              {t(`coverage.reason.${gap.reason}`)}
            </span>
            <LuChevronRight className="ml-auto size-3 shrink-0 self-center text-muted-foreground opacity-0 group-hover:opacity-100" />
          </button>
        ))}
      </div>
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
          {t("coverage.coverage")}
        </span>
      </div>
      <div className="text-xs text-muted-foreground">
        {missingSeconds < 1
          ? t("coverage.complete")
          : `${formatMissing(missingSeconds)} ${t(
              "coverage.missing",
            ).toLowerCase()} · ${t("coverage.affectedHours", {
              count: affectedHours,
            })}`}
      </div>
    </div>
  );
}

type CauseBreakdownProps = {
  causes: Cause[];
  missingSeconds: number;
};

function CauseBreakdown({ causes, missingSeconds }: CauseBreakdownProps) {
  const { t } = useTranslation(["views/system"]);

  // an empty table and a healthy camera look identical without this, and the
  // difference matters: causes are only known from the moment they happened
  if (causes.length === 0) {
    if (missingSeconds <= 0) return null;

    return (
      <div className="mt-1 text-xs text-muted-foreground">
        {t("coverage.reason.none")}
      </div>
    );
  }

  const worst = causes[0];

  return (
    <div className="mt-1 text-xs text-muted-foreground">
      <div className="flex flex-row flex-wrap items-center gap-x-3 gap-y-0.5">
        <span className="font-medium">{t("coverage.reason.label")}</span>
        {causes.map((cause) => (
          <span key={cause.reason} title={cause.detail ?? undefined}>
            {t(`coverage.reason.${cause.reason}`)}{" "}
            <span className="tabular-nums">{formatMissing(cause.seconds)}</span>
          </span>
        ))}
      </div>
      {worst.detail && (
        <div className="mt-0.5 truncate font-mono text-[11px] opacity-80">
          {worst.detail}
        </div>
      )}
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
      <div className="min-w-[470px] max-w-[640px]">
        <div className="flex flex-row items-center gap-1">
          <div className="w-12 shrink-0" />
          <div
            className="grid flex-1 gap-[2px] text-[10px] text-muted-foreground"
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
              className="grid flex-1 gap-[2px] py-[1px]"
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
  const reasonText = useReasonText();

  const label = useMemo(() => {
    const date = new TZDate(
      `${cell.dayKey}T00:00:00`,
      timezone,
    ).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const hour = `${pad2(cell.hour)}:00`;

    switch (cell.status) {
      case "outside":
        return t("coverage.cell.outside", { date, hour });
      case "inProgress":
        return t("coverage.cell.inProgress", { date, hour });
      case "complete":
        return t("coverage.cell.complete", { date, hour });
      case "empty":
        return t("coverage.cell.empty", { date, hour });
      default:
        return `${t("coverage.cell.loss", {
          date,
          hour,
          percent: ((1 - cell.missing) * 100).toFixed(1),
          missing: formatMissing(cell.missing * SECONDS_PER_HOUR),
        })} (${reasonText(cell.reasons)})`;
    }
  }, [cell, timezone, t, reasonText]);

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
          {t("coverage.profile.title")}
        </div>
        <div
          className="grid flex-1 gap-[2px]"
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
        {t("coverage.profile.description")}
      </div>
    </div>
  );
}
