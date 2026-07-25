#!/usr/bin/env bash
#
# Фоновый запуск бота и воркеров: pid-файлы в .run/, логи в logs/.
#
# Руками звать не нужно, всё через npm:
#   npm run up        docker + бот + воркеры фоном
#   npm start         бот + воркеры фоном (docker уже поднят)
#   npm stop          остановить оба процесса
#   npm run status    кто жив, включая контейнеры
#   npm run logs      tail -f по обоим логам
#   npm run down      остановить всё, включая docker
#
# Любую команду можно сузить до одного процесса:
#   npm start -- bot        npm stop -- worker        npm run logs -- worker
#
set -euo pipefail

cd "$(dirname "$0")/.."

RUN_DIR=.run
LOG_DIR=logs
TSX=node_modules/.bin/tsx
SERVICES=(bot worker)

# Точка входа процесса. tsx, а не node --experimental-strip-types: стриппер
# ноды не резолвит импорты вида './bot/index.js' в соседний .ts и падает.
entry() {
  case "$1" in
    bot)    echo src/index.ts ;;
    worker) echo src/workers/index.ts ;;
    *)      echo "неизвестный процесс: $1 (есть: ${SERVICES[*]})" >&2; return 1 ;;
  esac
}

# Печатает pid, если процесс из pid-файла ещё жив. Иначе просто фейлится:
# осиротевший pid-файл после kill -9 или перезагрузки — норма, не ошибка.
pid_of() {
  local file=$RUN_DIR/$1.pid pid
  [[ -f $file ]] || return 1
  pid=$(cat "$file")
  [[ -n $pid ]] && kill -0 "$pid" 2>/dev/null || return 1
  echo "$pid"
}

start_one() {
  local name=$1 target pid
  target=$(entry "$name")

  if pid=$(pid_of "$name"); then
    echo "$name уже работает (pid $pid)"
    return 0
  fi

  [[ -x $TSX ]] || { echo "нет $TSX — сначала npm install" >&2; return 1; }
  mkdir -p "$RUN_DIR" "$LOG_DIR"

  # nohup: процесс переживает закрытие консоли (SIGHUP игнорируется и после
  # exec). Логи дописываются, чтобы не терять предыдущий запуск.
  nohup "$TSX" "$target" >>"$LOG_DIR/$name.log" 2>&1 &
  pid=$!
  echo "$pid" >"$RUN_DIR/$name.pid"
  echo "$name запущен (pid $pid) → $LOG_DIR/$name.log"
}

stop_one() {
  local name=$1 pid
  if ! pid=$(pid_of "$name"); then
    rm -f "$RUN_DIR/$name.pid"
    echo "$name не запущен"
    return 0
  fi

  # SIGTERM, а не kill -9: у обоих процессов есть обработчик, он гасит long
  # polling, закрывает воркеры BullMQ (иначе взятые задачи повиснут до
  # истечения lock) и пул Postgres.
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 50); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.2
  done

  if kill -0 "$pid" 2>/dev/null; then
    echo "$name не ушёл за 10 с, добиваю SIGKILL"
    kill -KILL "$pid" 2>/dev/null || true
  fi

  rm -f "$RUN_DIR/$name.pid"
  echo "$name остановлен"
}

status_one() {
  local name=$1 pid
  if pid=$(pid_of "$name"); then
    printf '%-8s работает  pid %-8s %s\n' "$name" "$pid" \
      "$(ps -o etime= -p "$pid" 2>/dev/null | tr -d ' ' | sed 's/^/uptime /')"
  else
    printf '%-8s не запущен\n' "$name"
  fi
}

# Список процессов: аргументы команды или все сразу.
targets() {
  if [[ $# -gt 0 ]]; then printf '%s\n' "$@"; else printf '%s\n' "${SERVICES[@]}"; fi
}

cmd=${1:-status}
shift || true

case "$cmd" in
  start)
    for s in $(targets "$@"); do start_one "$s"; done
    ;;

  stop)
    for s in $(targets "$@"); do stop_one "$s"; done
    ;;

  restart)
    for s in $(targets "$@"); do stop_one "$s"; done
    for s in $(targets "$@"); do start_one "$s"; done
    ;;

  up)
    # --wait: ждём healthcheck'и из docker-compose.yml. Без этого бот стартует
    # раньше Postgres и падает на первом запросе.
    docker compose up -d --wait
    for s in $(targets "$@"); do start_one "$s"; done
    ;;

  down)
    for s in "${SERVICES[@]}"; do stop_one "$s"; done
    # stop, а не down: контейнеры остаются, следующий npm run up быстрее.
    # Снести совсем — docker compose down (данные в volume переживут и это).
    docker compose stop
    ;;

  status)
    for s in "${SERVICES[@]}"; do status_one "$s"; done
    echo
    docker compose ps
    ;;

  logs)
    mkdir -p "$LOG_DIR"
    files=()
    for s in $(targets "$@"); do
      entry "$s" >/dev/null
      touch "$LOG_DIR/$s.log"
      files+=("$LOG_DIR/$s.log")
    done
    tail -n 40 -f "${files[@]}"
    ;;

  *)
    echo "usage: $0 {up|start|stop|restart|status|logs|down} [bot|worker]" >&2
    exit 1
    ;;
esac
