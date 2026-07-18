import type { ReactNode } from "react";
import { Skeleton } from "@mantine/core";
import styles from "@/pages/dashboard/DashboardPage.module.css";

export function DashboardMetricCard({
  icon,
  label,
  loading,
  value,
}: {
  icon: ReactNode;
  label: string;
  loading?: boolean;
  value: string;
}) {
  return (
    <div className={styles.metricCard} data-dashboard-metric>
      <span aria-hidden className={styles.metricIcon}>
        {icon}
      </span>
      <div className={styles.metricCopy}>
        <div className={styles.metricLabel}>{label}</div>
        {loading ? (
          <Skeleton aria-hidden height={28} mt={5} radius="sm" width={72} />
        ) : (
          <div className={styles.metricValue}>{value}</div>
        )}
      </div>
    </div>
  );
}
