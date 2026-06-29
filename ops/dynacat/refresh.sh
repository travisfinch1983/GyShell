#!/bin/sh
# Probe the cluster for real listening services, then regenerate the Dynacat config.
/usr/bin/python3 /opt/dynacat/cluster-probe.py
/usr/bin/python3 /opt/dynacat/gen-dynacat-config.py
