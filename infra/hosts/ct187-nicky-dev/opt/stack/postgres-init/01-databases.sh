#!/bin/bash
# First start only: the authentik and app databases, each with its own owner.
set -e
psql -v ON_ERROR_STOP=1 -U postgres <<SQL
CREATE USER authentik WITH PASSWORD '${PG_AUTHENTIK_PASSWORD}';
CREATE DATABASE authentik OWNER authentik;
CREATE USER app WITH PASSWORD '${PG_APP_PASSWORD}';
CREATE DATABASE app OWNER app;
\c app
CREATE EXTENSION IF NOT EXISTS vector;
SQL
