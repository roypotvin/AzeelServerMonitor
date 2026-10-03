-- AzeelServerMonitor v1 tables for the mothership (Aurora/MySQL).
-- Provision as-is; the monitor writes via `AzeelServerMonitorStats.insert`
-- and `AzeelServerMonitorIssues.insert` with exactly the column names below.
--
-- Stats: one row per push interval (default every 5 min), healthy or not.
-- Issues: rows ONLY on problems (watch/critical alerts). The monitor never
-- writes "everything is fine" rows.

CREATE TABLE IF NOT EXISTS AzeelServerMonitorStats (
  stat_id       BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  stat_ts       DATETIME        NOT NULL,
  hostname      VARCHAR(255)    NOT NULL,
  uptime_sec    BIGINT          NOT NULL DEFAULT 0,
  load1         DECIMAL(6,2)    NOT NULL DEFAULT 0,
  load5         DECIMAL(6,2)    NOT NULL DEFAULT 0,
  load15        DECIMAL(6,2)    NOT NULL DEFAULT 0,
  cpus          INT             NOT NULL DEFAULT 0,
  cpu_model     VARCHAR(255)    NOT NULL DEFAULT '',
  cpu_usage_pct DECIMAL(5,2)    NOT NULL DEFAULT 0,
  mem_total_mb  INT             NOT NULL DEFAULT 0,
  mem_used_mb   INT             NOT NULL DEFAULT 0,
  mem_avail_mb  INT             NOT NULL DEFAULT 0,
  mem_used_pct  DECIMAL(5,2)    NOT NULL DEFAULT 0,
  swap_total_mb INT             NOT NULL DEFAULT 0,
  swap_used_mb  INT             NOT NULL DEFAULT 0,
  swap_used_pct DECIMAL(5,2)    NOT NULL DEFAULT 0,
  worst_disk_pct  TINYINT UNSIGNED NOT NULL DEFAULT 0,
  worst_inode_pct TINYINT UNSIGNED NOT NULL DEFAULT 0,
  ips           VARCHAR(1024)   NOT NULL DEFAULT '',
  public_ip     VARCHAR(64)     NOT NULL DEFAULT '',
  proc_count    INT             NOT NULL DEFAULT 0,
  top_procs     TEXT,
  cursor_builds TEXT,
  oom_recent    TEXT,
  PRIMARY KEY (stat_id),
  KEY idx_azeelservermonitorstats_host_ts (hostname, stat_ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS AzeelServerMonitorIssues (
  issue_id     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  issue_ts     DATETIME        NOT NULL,
  hostname     VARCHAR(255)    NOT NULL,
  level        VARCHAR(16)     NOT NULL,
  source       VARCHAR(64)     NOT NULL DEFAULT '',
  message      TEXT,
  context_json TEXT,
  PRIMARY KEY (issue_id),
  KEY idx_azeelservermonitorissues_host_ts (hostname, issue_ts),
  KEY idx_azeelservermonitorissues_level_ts (level, issue_ts)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
