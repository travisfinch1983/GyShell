#!/bin/sh
# Probe the cluster for real listening services (AI-Lab owns the probe + output), then regenerate Dynacat.
/usr/bin/python3 /opt/ai-lab/cluster-probe/cluster-probe.py
/usr/bin/python3 /opt/dynacat/gen-dynacat-config.py
