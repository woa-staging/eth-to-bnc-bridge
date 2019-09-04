#!/bin/bash

set -e

cd $(dirname "$0")

# either development or staging
TARGET_NETWORK=${TARGET_NETWORK:=development}

echo "Using $TARGET_NETWORK network"

docker build -t ethereum-send . > /dev/null

docker run --network blockchain_side --rm --env-file ".env.$TARGET_NETWORK" --env-file "../.keys.$TARGET_NETWORK" ethereum-send $@