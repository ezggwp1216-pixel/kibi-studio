# Build context: the public server/ directory. No host tools are installed.
# Keep the same immutable Node 24 base as the standalone server.
FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS build
ARG TARGETARCH
# Snapshot metadata pins the complete build-tool dependency graph, not live apt.
RUN rm -f /etc/apt/sources.list.d/debian.sources \
 && printf '%s\n' \
      'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20261116T000000Z bookworm main' \
      'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/20261116T000000Z bookworm-updates main' \
      'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/20261116T000000Z bookworm-security main' \
      > /etc/apt/sources.list \
 && apt-get -o Acquire::Check-Valid-Until=false update \
 && apt-get install -y --no-install-recommends build-essential git ca-certificates curl unzip pkg-config \
 && rm -rf /var/lib/apt/lists/*
# Official FFmpeg 9.0.2 source, immutable commit verified against its official mirror.
RUN git init /tmp/ffmpeg \
 && git -C /tmp/ffmpeg remote add origin https://github.com/FFmpeg/FFmpeg.git \
 && git -C /tmp/ffmpeg fetch --depth=1 origin 946fcce07b6dcd0331c8cc609192aeff5e1924f8 \
 && git -C /tmp/ffmpeg checkout --detach 946fcce07b6dcd0331c8cc609192aeff5e1924f8 \
 && test "$(git -C /tmp/ffmpeg rev-parse HEAD)" = 946fcce07b6dcd0331c8cc609192aeff5e1924f8 \
 && cd /tmp/ffmpeg \
 && ./configure --prefix=/out --disable-doc --disable-debug --disable-autodetect --disable-network --disable-protocols --enable-protocol=pipe --disable-devices --disable-ffplay --disable-ffprobe --disable-x86asm --disable-encoders --enable-encoder=rawvideo --disable-muxers --enable-muxer=rawvideo \
 && make -j2 \
 && make install \
 && cp COPYING.LGPLv2.1 /out/FFmpeg-COPYING.LGPLv2.1 \
 && /out/bin/ffmpeg -buildconf > /out/FFmpeg-buildconf.txt 2>&1
# Official yt-dlp 2026.10.26 unpackaged releases contain their pinned EJS code.
# An onedir build does not unpack executable libraries into noexec /tmp.
RUN case "${TARGETARCH:-$(dpkg --print-architecture)}" in \
      amd64) asset=yt-dlp_linux.zip; expected=f34053415136e55073dd64ba5326d161ecc23ce0e98c081d8752867b37809450 ;; \
      arm64) asset=yt-dlp_linux_aarch64.zip; expected=74708e707e8fa8177c8347e58152337edf320149cd7b225defd453f7cde47822 ;; \
      *) exit 1 ;; \
    esac \
 && curl --fail --location --proto '=https' --tlsv1.2 "https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/$asset" -o /tmp/yt-dlp.zip \
 && printf '%s  %s\n' "$expected" /tmp/yt-dlp.zip | sha256sum --check --strict \
 && mkdir -p /opt/yt-dlp \
 && unzip -q /tmp/yt-dlp.zip -d /opt/yt-dlp \
 && tool_path="$(find /opt/yt-dlp -type f -name 'yt-dlp*' -perm /111 -print -quit)" \
 && test -n "$tool_path" \
 && ln -s "$tool_path" /usr/local/bin/yt-dlp \
 && /usr/local/bin/yt-dlp --ignore-config --no-plugin-dirs --no-remote-components --version

FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
WORKDIR /worker
ENV HOME=/tmp TMPDIR=/tmp XDG_CACHE_HOME=/tmp
COPY --from=build /out/bin/ffmpeg /usr/local/bin/ffmpeg
COPY --from=build /out/FFmpeg-COPYING.LGPLv2.1 /out/FFmpeg-buildconf.txt /usr/share/kibi-media/
COPY --from=build /opt/yt-dlp/ /opt/yt-dlp/
RUN tool_path="$(find /opt/yt-dlp -type f -name 'yt-dlp*' -perm /111 -print -quit)" \
 && test -n "$tool_path" \
 && ln -s "$tool_path" /usr/local/bin/yt-dlp
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY workers/media/worker.mjs /worker/worker.mjs
COPY workers/media/dependencies.json /usr/share/kibi-media/dependencies.json
USER 65532:65532
ENTRYPOINT ["node", "--disable-proto=throw", "--no-addons", "/worker/worker.mjs"]
