FROM ubuntu:22.04@sha256:5ec03bb3441e8b0bf3b4f9cd4629a1ae763010dc3035bb8da3ae6cf026486401
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl build-essential pkg-config libfontconfig1-dev \
    libx11-6 libx11-xcb1 libxcb1 libxcb-render0 libxcb-shape0 libxcb-xfixes0 \
    libxcursor1 libxi6 libxrandr2 libxinerama1 libxkbcommon0 libxkbcommon-x11-0 \
    libwayland-client0 libwayland-cursor0 libwayland-egl1 libxrender1 libxfixes3 \
    fonts-noto-cjk fonts-dejavu-core librsvg2-bin patchelf desktop-file-utils \
    shared-mime-info xdg-utils squashfs-tools python3 git xz-utils xvfb \
    dbus-x11 xdg-desktop-portal xdg-desktop-portal-gtk \
    && rm -rf /var/lib/apt/lists/*
ENV CARGO_HOME=/opt/cargo RUSTUP_HOME=/opt/rustup
ENV PATH=/opt/cargo/bin:/opt/node/bin:$PATH
RUN curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs -o /tmp/rustup.sh \
    && sh /tmp/rustup.sh -y --profile minimal --default-toolchain 1.98.1 \
    && rm /tmp/rustup.sh
COPY storage-agent-runtime-lock.json /tmp/node-lock.json
RUN python3 -c 'import json; d=json.load(open("/tmp/node-lock.json")); t=d["targets"]["linux-x64"]; print(d["baseUrl"]+"/"+t["archive"]); print(t["sha256"])' > /tmp/node-download \
    && curl -fL "$(head -1 /tmp/node-download)" -o /tmp/node.tar.xz \
    && echo "$(tail -1 /tmp/node-download)  /tmp/node.tar.xz" | sha256sum -c - \
    && mkdir /opt/node && tar -xf /tmp/node.tar.xz -C /opt/node --strip-components=1 \
    && rm /tmp/node.tar.xz \
    && npm install -g pnpm@10.33.4
RUN curl -fL https://github.com/AppImage/appimagetool/releases/download/1.9.1/appimagetool-x86_64.AppImage -o /opt/appimagetool.AppImage \
    && echo 'ed4ce84f0d9caff66f50bcca6ff6f35aae54ce8135408b3fa33abfc3cb384eb0  /opt/appimagetool.AppImage' | sha256sum -c - \
    && chmod +x /opt/appimagetool.AppImage \
    && cd /opt && /opt/appimagetool.AppImage --appimage-extract >/dev/null \
    && curl -fL https://github.com/AppImage/type2-runtime/releases/download/20251108/runtime-x86_64 -o /opt/appimage-runtime \
    && echo '2fca8b443c92510f1483a883f60061ad09b46b978b2631c807cd873a47ec260d  /opt/appimage-runtime' | sha256sum -c -
RUN apt-get update && apt-get install -y --no-install-recommends libglib2.0-bin file && rm -rf /var/lib/apt/lists/*
WORKDIR /work
