{ lib, stdenv, fetchurl, dpkg, autoPatchelfHook, makeWrapper, xdg-utils }:

stdenv.mkDerivation rec {
  pname = "pearcircle-watch";
  version = "1.1.7";

  src = fetchurl {
    url = "https://github.com/peerloomllc/pearcircle/releases/download/v${version}/pearcircle-watch_${version}_amd64.deb";
    hash = "sha256-NdpNoQS81ACJPC9RF3YLqTPPgRSAzp1XxbwHuOLpmss=";
  };

  nativeBuildInputs = [ dpkg autoPatchelfHook makeWrapper ];

  # libstdc++, libgcc_s and libatomic (needed by node, bare and the prebuilt .node addons)
  buildInputs = [ stdenv.cc.cc.lib ];

  unpackPhase = "dpkg-deb -x $src .";

  # Don't strip the bundled node/bare binaries
  dontStrip = true;

  installPhase = ''
    runHook preInstall

    mkdir -p $out/opt $out/bin $out/share
    cp -r opt/pearcircle-watch $out/opt/pearcircle-watch
    cp -r usr/share/icons $out/share/icons
    install -Dm444 usr/share/applications/pearcircle-watch.desktop \
      $out/share/applications/pearcircle-watch.desktop

    substituteInPlace $out/share/applications/pearcircle-watch.desktop \
      --replace-fail "/usr/bin/pearcircle-watch" "pearcircle-watch"

    # Replace the vendor launcher (#!/usr/bin/env bash + exec node host-bundled.js)
    makeWrapper $out/opt/pearcircle-watch/node $out/bin/pearcircle-watch \
      --add-flags "$out/opt/pearcircle-watch/host-bundled.js" \
      --prefix PATH : ${lib.makeBinPath [ xdg-utils ]}

    runHook postInstall
  '';

  meta = {
    description = "PearCircle watch-only desktop client";
    homepage = "https://peerloomllc.com";
    platforms = [ "x86_64-linux" ];
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
    mainProgram = "pearcircle-watch";
  };
}
