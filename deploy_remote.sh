#!/bin/bash

# Configuration
REMOTE_USER="john"
REMOTE_HOST="192.168.0.177"
TARGET_DIR="/opt/lampp/htdocs/devPOS"

echo "Deploying to ${REMOTE_USER}@${REMOTE_HOST}:${TARGET_DIR}"

# 1. Stop XAMPP & Prepare Directory
# -t forces TTY allocation for sudo password prompt
echo "Stopping remote XAMPP and preparing directory..."
ssh -t ${REMOTE_USER}@${REMOTE_HOST} "sudo /opt/lampp/lampp stop; sudo mkdir -p ${TARGET_DIR}; sudo chown -R ${REMOTE_USER} ${TARGET_DIR}"

# 2. Sync Files
echo "Syncing project files..."
rsync -avz --delete \
    --exclude '.git' \
    --exclude 'node_modules' \
    --exclude 'data/restore.lock' \
    --exclude 'data/database.sqlite' \
    ./ ${REMOTE_USER}@${REMOTE_HOST}:${TARGET_DIR}/

# 3. Finalize on Remote
echo "Running final setup on remote..."
ssh -t ${REMOTE_USER}@${REMOTE_HOST} "sudo bash ${TARGET_DIR}/remote_finish.sh"

echo "Deployment Done."
