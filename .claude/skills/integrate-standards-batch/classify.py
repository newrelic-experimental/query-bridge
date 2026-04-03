#!/usr/bin/env python3
"""Classify discover.sh output into tiers.

Usage: discover.sh .. | python3 classify.sh [--skip-config <path>]
Reads pipe-delimited lines from stdin, outputs JSON to stdout.
"""
import sys
import json
from datetime import datetime, timedelta

def main():
    skip_config_path = None
    args = sys.argv[1:]
    while args:
        if args[0] == '--skip-config' and len(args) > 1:
            skip_config_path = args[1]
            args = args[2:]
        else:
            args = args[1:]

    # Load skip config
    skipped_paths = {}
    if skip_config_path:
        try:
            with open(skip_config_path) as f:
                cfg = json.load(f)
                skipped_paths = cfg.get('skipped', {})
        except (FileNotFoundError, json.JSONDecodeError):
            pass

    now = datetime.now()
    three_months_ago = now - timedelta(days=90)
    six_months_ago = now - timedelta(days=180)

    integrated = []
    recommended = []
    maybe = []
    probably_not = []
    previously_skipped = []

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        parts = line.split('|')
        record_type = parts[0]

        if record_type == 'INTEGRATED':
            # INTEGRATED|name|version|path
            name, version, path = parts[1], parts[2], parts[3].rstrip('/')
            integrated.append({
                'name': name,
                'version': version,
                'path': path
            })

        elif record_type == 'CANDIDATE':
            # CANDIDATE|name|stack|last_commit_date|is_readonly|path
            name = parts[1]
            stack = parts[2]
            last_commit = parts[3]
            is_readonly = parts[4] == 'true'
            path = parts[5].rstrip('/')

            # Check if previously skipped
            if path in skipped_paths or path + '/' in skipped_paths:
                previously_skipped.append({
                    'name': name,
                    'stack': stack,
                    'path': path,
                    'reason': skipped_paths.get(path, skipped_paths.get(path + '/', 'previously skipped'))
                })
                continue

            # Parse commit date
            commit_date = None
            if last_commit != 'no-git':
                try:
                    commit_date = datetime.strptime(last_commit.split(' ')[0], '%Y-%m-%d')
                except ValueError:
                    pass

            # Classify
            if is_readonly:
                probably_not.append({
                    'name': name, 'stack': stack,
                    'last_commit': last_commit.split(' ')[0] if commit_date else 'no-git',
                    'path': path, 'reason': 'read-only clone'
                })
            elif commit_date is None:
                probably_not.append({
                    'name': name, 'stack': stack,
                    'last_commit': 'no-git',
                    'path': path, 'reason': 'no git history'
                })
            elif commit_date < six_months_ago:
                probably_not.append({
                    'name': name, 'stack': stack,
                    'last_commit': commit_date.strftime('%Y-%m-%d'),
                    'path': path, 'reason': 'inactive (>6 months)'
                })
            elif commit_date < three_months_ago:
                maybe.append({
                    'name': name, 'stack': stack,
                    'last_commit': commit_date.strftime('%Y-%m-%d'),
                    'path': path
                })
            else:
                recommended.append({
                    'name': name, 'stack': stack,
                    'last_commit': commit_date.strftime('%Y-%m-%d'),
                    'path': path
                })

    json.dump({
        'integrated': integrated,
        'recommended': recommended,
        'maybe': maybe,
        'probably_not': probably_not,
        'previously_skipped': previously_skipped
    }, sys.stdout, indent=2)
    print()

if __name__ == '__main__':
    main()
