#!/bin/bash
# 为 LiteLLM 创建独立数据库
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE DATABASE litellm;
    GRANT ALL PRIVILEGES ON DATABASE litellm TO $POSTGRES_USER;
EOSQL

echo "LiteLLM database 'litellm' created successfully"
