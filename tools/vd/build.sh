#!/data/data/com.termux/files/usr/bin/bash
# build.sh — 编译 Termux 侧虚拟副屏的 dex
#
# 【产物】tools/vd/build/vd.dex
# 【用法】bash tools/vd/build.sh
#
# 编出来的 dex 用 app_process 加载：
#   CLASSPATH=<vd.dex> /system/bin/app_process /system/bin --nice-name=ccm-vd vd.VdMain
#
# 【为什么不用 gradle】这是个 3 文件的小 Java 工程，且要跑在 Termux 上。
# javac + d8 各一条命令就够，引构建系统纯属负担。

set -e

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/src"
OUT="$HERE/build"
LIB="$HERE/android.jar"

# android.jar 是编译期的类签名来源（运行时用设备上真实的 framework）。
# 25MB 不进版本库，缺失就自动下。
ANDROID_JAR_URL="https://gh-proxy.com/https://raw.githubusercontent.com/Sable/android-platforms/master/android-35/android.jar"

mkdir -p "$OUT"

if [ ! -f "$LIB" ]; then
  echo "下载 android.jar（编译期依赖，约 25MB）…"
  curl -sL --max-time 300 -o "$LIB" "$ANDROID_JAR_URL"
  sz=$(stat -c%s "$LIB" 2>/dev/null || echo 0)
  if [ "$sz" -lt 1000000 ]; then
    echo "下载失败（只有 ${sz} 字节）。手动放到：$LIB"
    exit 1
  fi
  echo "  完成：$((sz/1024/1024))MB"
fi

command -v javac >/dev/null 2>&1 || { echo "缺 javac。装：pkg install openjdk-21"; exit 1; }
command -v d8 >/dev/null 2>&1 || { echo "缺 d8。装：pkg install dx 或 android-tools"; exit 1; }

echo "编译 Java…"
rm -rf "$OUT/classes"
mkdir -p "$OUT/classes"
javac -nowarn -source 8 -target 8 -classpath "$LIB" -d "$OUT/classes" \
  "$SRC"/vd/*.java 2>&1 | grep -v 'bootstrap class path\|source value 8\|target value 8\|deprecat' || true

if [ ! -d "$OUT/classes/vd" ]; then
  echo "编译失败：没有产出 class 文件"
  exit 1
fi

echo "转 dex…"
# 注意：d8 的输出名固定是 classes.dex（不给 --output 文件名时），
# 所以先清旧的、跑完再改名 —— 直接找 vd.dex 会永远找不到。
rm -f "$OUT/classes.dex" "$OUT/vd.dex"
d8 --min-api 26 --lib "$LIB" --output "$OUT" $(find "$OUT/classes" -name '*.class')

if [ -f "$OUT/classes.dex" ]; then
  mv "$OUT/classes.dex" "$OUT/vd.dex"
fi

if [ ! -f "$OUT/vd.dex" ]; then
  echo "d8 失败：没有产出 dex"
  exit 1
fi

sz=$(stat -c%s "$OUT/vd.dex")
echo "完成：$OUT/vd.dex（$((sz/1024))KB）"
echo
echo "在设备上启动："
echo "  CLASSPATH=$OUT/vd.dex /system/bin/app_process /system/bin --nice-name=ccm-vd vd.VdMain"
