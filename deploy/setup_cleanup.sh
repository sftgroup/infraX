#!/bin/bash
# Run as: sudo bash /tmp/setup_cleanup.sh

cp /tmp/infrax-cleanup.sh /opt/infrax-cleanup.sh
chmod +x /opt/infrax-cleanup.sh
echo "Script copied to /opt"

cat > /etc/systemd/system/infrax-cleanup.service << 'SVCEND'
[Unit]
Description=InfraX Data Retention Cleanup (5 days)
After=postgresql.service
Requires=postgresql.service

[Service]
Type=oneshot
ExecStart=/opt/infrax-cleanup.sh
StandardOutput=journal
StandardError=journal
SVCEND
echo "Service created"

cat > /etc/systemd/system/infrax-cleanup.timer << 'TMREND'
[Unit]
Description=InfraX Data Retention Cleanup Timer (daily at 3:00 AM)

[Timer]
OnCalendar=daily
Persistent=true

[Install]
WantedBy=timers.target
TMREND
echo "Timer created"

systemctl daemon-reload
systemctl enable infrax-cleanup.timer
systemctl start infrax-cleanup.timer
echo "=== Timer status ==="
systemctl --no-pager status infrax-cleanup.timer | head -6
echo ""
echo "=== Timer list ==="
systemctl --no-pager list-timers --all | grep infrax