-- Runs once when the PostgreSQL volume is first created.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
-- Database for the optional reference web software (profile "reference-websoft").
CREATE DATABASE websoft OWNER bamp;
