# Per Bot 55 — replacing Nixpacks for this service entirely. Two
# different, individually-documented Nixpacks approaches to installing
# ffmpeg (aptPkgs, then nixPkgs — both following Nixpacks' own official
# docs) each failed with the identical "spawn ffprobe ENOENT" once
# actually deployed. Rather than keep guessing at Nixpacks-specific
# quirks with no way to test them outside a real deploy, this switches
# to a plain Dockerfile — full, guaranteed control over exactly what's
# installed, using the most standard, well-understood method there is:
# a straightforward apt-get install on Debian. Railway auto-detects a
# Dockerfile and builds from it instead of Nixpacks once this file is
# present — nixpacks.toml can stay in the repo harmlessly (it's simply
# ignored once a Dockerfile exists) or be deleted; either is fine.
#
# node:20-bookworm-slim: current Node LTS, Debian-based specifically so
# apt-get is available (some slim variants are Alpine-based instead,
# which uses apk, not apt — bookworm avoids that mismatch entirely).
FROM node:20-bookworm-slim

# Debian's standard ffmpeg package reliably bundles ffprobe as part of
# the same package — this is the ordinary, well-established way most
# people get both binaries, not a special case.
#
# poppler-utils (Per's request) — provides pdftohtml, used by
# pdf-to-epub.js to convert lesson PDFs into real, reflowable EPUBs on
# upload, replacing the broken image-in-an-iframe mobile reading
# experience for those files. Same reasoning as ffmpeg just above: a
# standard Debian package via plain apt-get, not a Nixpacks-specific
# workaround.
#
# libreoffice-impress (Per's request) — pptx-to-slides.js uses this for
# `soffice --headless --convert-to pdf` on uploaded presentations, then
# poppler-utils (already above) rasterizes each page to a slide image.
# Deliberately libreoffice-impress rather than the full libreoffice
# meta-package: pulls in libreoffice-core and libreoffice-draw as real
# dependencies regardless, but skips Writer/Calc/Base, which this app
# has no use for. Still a genuinely large package — this will make the
# NEXT Railway build noticeably slower than usual (a full image rebuild,
# same as when ffmpeg was first added), not a quick redeploy.
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg poppler-utils libreoffice-impress \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first, separately from copying the rest of the
# app — Docker layer caching means this step only re-runs when
# package.json/package-lock.json actually change, not on every code
# edit, so ordinary deploys stay fast.
COPY package.json package-lock.json ./
RUN npm install --omit=dev

COPY . .

# Railway sets PORT itself at runtime — this app already reads
# process.env.PORT (see server.js), so nothing needs to be hardcoded
# here for that to work correctly.
CMD ["node", "server.js"]
