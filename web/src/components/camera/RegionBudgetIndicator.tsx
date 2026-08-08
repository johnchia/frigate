import { useTranslation } from "react-i18next";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type RegionBudgetIndicatorProps = {
  budget?: number | null;
  enforced?: boolean;
  requested?: number;
  admitted?: number;
  shed?: number;
};

export function RegionBudgetIndicator({
  budget,
  enforced,
  requested,
  admitted,
  shed,
}: RegionBudgetIndicatorProps) {
  const { t } = useTranslation(["views/system"]);

  // nothing meaningful to show until a budget has been derived
  if (budget == null) {
    return null;
  }

  const totalRequested = requested ?? 0;
  const shedCount = shed ?? 0;
  const shedPercent =
    totalRequested > 0 ? Math.round((shedCount / totalRequested) * 100) : 0;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn(
            "cursor-pointer rounded-full px-1.5 py-0.5 text-[10px] font-medium",
            enforced && shedPercent > 0
              ? "bg-orange-500/20 text-orange-500"
              : "bg-secondary text-muted-foreground",
          )}
        >
          {t("cameras.regionBudget.perSecond", { rate: budget })}
        </div>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        <div className="space-y-2">
          <div className="font-semibold">{t("cameras.regionBudget.title")}</div>
          <div className="text-sm">
            <div>{t("cameras.regionBudget.description")}</div>
            <div className="mt-2 space-y-1 text-xs">
              <div>
                {t("cameras.regionBudget.budget")}:{" "}
                {t("cameras.regionBudget.perSecond", { rate: budget })}
              </div>
              <div>
                {t("cameras.regionBudget.requested")}: {totalRequested}
              </div>
              <div>
                {t("cameras.regionBudget.admitted")}: {admitted ?? 0}
              </div>
              <div>
                {t("cameras.regionBudget.shed")}: {shedCount}
                {totalRequested > 0 &&
                  ` (${t("cameras.regionBudget.shedPercent", {
                    percent: shedPercent,
                  })})`}
              </div>
              <div>
                {enforced
                  ? t("cameras.regionBudget.enforced")
                  : t("cameras.regionBudget.observing")}
              </div>
            </div>
          </div>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
