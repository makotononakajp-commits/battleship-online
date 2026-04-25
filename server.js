const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;
const ALLOWED_SIZES = [7, 8, 9];
const DEFAULT_SIZE = 7;

const SHIPS = [
  { name: "船①", cells: [[0, 0], [1, 0]] },
  { name: "船②", cells: [[0, 0], [1, 0], [2, 0]] },
  { name: "船③", cells: [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1]] },
  { name: "船④", cells: [[0, 0], [1, 0], [2, 0], [3, 0]] }
];

app.use(express.static(path.join(__dirname, "public")));

function createBoard(size) {
  return Array.from({ length: size }, () =>
    Array.from({ length: size }, () => ({
      ship: false,
      hit: false,
      wave: false
    }))
  );
}

function createPlayer(socketId, playerNumber, boardSize) {
  return {
    socketId,
    playerNumber,
    ownBoard: createBoard(boardSize),
    totalShipCells: 0,
    hitsReceived: 0,
    placementDone: false
  };
}

function rotatePoint90([x, y]) {
  return [y, -x];
}

function normalizeShape(cells) {
  const minX = Math.min(...cells.map(c => c[0]));
  const minY = Math.min(...cells.map(c => c[1]));
  return cells.map(([x, y]) => [x - minX, y - minY]);
}

function getRotatedShipCells(baseCells, rotation) {
  let result = baseCells.map(c => [...c]);
  for (let i = 0; i < rotation; i++) {
    result = result.map(rotatePoint90);
    result = normalizeShape(result);
  }
  return result;
}

function canPlaceShip(board, shipCells, originX, originY, boardSize) {
  for (const [dx, dy] of shipCells) {
    const x = originX + dx;
    const y = originY + dy;

    if (x < 0 || x >= boardSize || y < 0 || y >= boardSize) return false;
    if (board[y][x].ship) return false;
  }
  return true;
}

function buildBoardFromPlacements(placements, boardSize) {
  const board = createBoard(boardSize);
  let totalShipCells = 0;

  for (let i = 0; i < SHIPS.length; i++) {
    const ship = SHIPS[i];
    const placement = placements[i];

    if (!placement) {
      return { ok: false, reason: `${ship.name} の配置が不足しています` };
    }

    const rotated = getRotatedShipCells(ship.cells, placement.rotation);

    if (!canPlaceShip(board, rotated, placement.x, placement.y, boardSize)) {
      return { ok: false, reason: `${ship.name} をその位置に置けません` };
    }

    for (const [dx, dy] of rotated) {
      const x = placement.x + dx;
      const y = placement.y + dy;
      board[y][x].ship = true;
      totalShipCells++;
    }
  }

  return { ok: true, board, totalShipCells };
}

function isAdjacentToShip(board, x, y, boardSize) {
  const dirs = [
    [0, -1],
    [-1, 0],
    [1, 0],
    [0, 1]
  ];

  for (const [dx, dy] of dirs) {
    const nx = x + dx;
    const ny = y + dy;

    if (nx < 0 || nx >= boardSize || ny < 0 || ny >= boardSize) continue;
    if (board[ny][nx].ship) return true;
  }

  return false;
}

function getPublicOwnBoard(player) {
  return player.ownBoard.map(row =>
    row.map(cell => ({
      ship: cell.ship,
      hit: cell.hit,
      wave: cell.wave
    }))
  );
}

function getRoomPublicState(room) {
  return {
    roomId: room.roomId,
    boardSize: room.boardSize,
    phase: room.phase,
    turn: room.turn,
    winner: room.winner,
    players: room.players.map(p => ({
      socketId: p.socketId,
      playerNumber: p.playerNumber,
      placementDone: p.placementDone,
      totalShipCells: p.totalShipCells,
      hitsReceived: p.hitsReceived
    }))
  };
}

function getPlayerRoom(socketId) {
  for (const room of rooms.values()) {
    if (room.players.some(p => p.socketId === socketId)) {
      return room;
    }
  }
  return null;
}

const rooms = new Map();

io.on("connection", socket => {
  socket.on("joinRoom", ({ roomId, boardSize }) => {
  const normalizedRoomId = String(roomId || "").trim().toUpperCase();
  const selectedSize = Number(boardSize) || DEFAULT_SIZE;

  if (!normalizedRoomId) {
    socket.emit("errorMessage", "部屋IDを入力してください。");
    return;
  }

  if (!ALLOWED_SIZES.includes(selectedSize)) {
    socket.emit("errorMessage", "盤面サイズは 7、8、9 のどれかを選んでください。");
    return;
  }

  let room = rooms.get(normalizedRoomId);

  if (!room) {
    room = {
      roomId: normalizedRoomId,
      boardSize: selectedSize,
      phase: "waiting",
      players: [],
      turn: null,
      winner: null
    };
    rooms.set(normalizedRoomId, room);
  } else {
    if (room.boardSize !== selectedSize) {
      socket.emit(
        "errorMessage",
        `この部屋は ${room.boardSize}×${room.boardSize} 用です。${room.boardSize}×${room.boardSize} を選んで入り直してください。`
      );
      return;
    }
  }

  if (room.players.some(p => p.socketId === socket.id)) {
    socket.emit("errorMessage", "すでに入室しています。");
    return;
  }

  if (room.players.length >= 2) {
    socket.emit("errorMessage", "この部屋は満員です。");
    return;
  }

  const playerNumber = room.players.length + 1;
  const player = createPlayer(socket.id, playerNumber, room.boardSize);
  room.players.push(player);
  socket.join(normalizedRoomId);

  socket.emit("joinedRoom", {
    roomId: normalizedRoomId,
    playerNumber,
    boardSize: room.boardSize
  });

  io.to(normalizedRoomId).emit("roomState", getRoomPublicState(room));

  if (room.players.length === 2) {
    room.phase = "placement";
    io.to(normalizedRoomId).emit("roomState", getRoomPublicState(room));
    io.to(normalizedRoomId).emit("systemMessage", "2人そろいました。船を配置してください。");
  } else {
    socket.emit("systemMessage", "入室しました。相手の参加を待っています。");
  }
});

  socket.on("submitPlacement", ({ roomId, placements }) => {
    const room = rooms.get(String(roomId || "").trim().toUpperCase());
    if (!room) {
      socket.emit("errorMessage", "部屋が見つかりません。");
      return;
    }

    const player = room.players.find(p => p.socketId === socket.id);
    if (!player) {
      socket.emit("errorMessage", "この部屋のプレイヤーではありません。");
      return;
    }

    if (room.phase !== "placement") {
      socket.emit("errorMessage", "いまは配置フェーズではありません。");
      return;
    }

    if (!Array.isArray(placements) || placements.length !== SHIPS.length) {
      socket.emit("errorMessage", "船の配置データが不正です。");
      return;
    }

    const built = buildBoardFromPlacements(placements, room.boardSize);
    if (!built.ok) {
      socket.emit("errorMessage", built.reason);
      return;
    }

    player.ownBoard = built.board;
    player.totalShipCells = built.totalShipCells;
    player.hitsReceived = 0;
    player.placementDone = true;

    socket.emit("placementAccepted", {
      ownBoard: getPublicOwnBoard(player)
    });

    io.to(room.roomId).emit("roomState", getRoomPublicState(room));

    if (room.players.length === 2 && room.players.every(p => p.placementDone)) {
      room.phase = "battle";
      room.turn = Math.random() < 0.5 ? 1 : 2;
      io.to(room.roomId).emit("roomState", getRoomPublicState(room));
      io.to(room.roomId).emit("systemMessage", `両プレイヤーの配置が完了しました。先手はプレイヤー${room.turn}です。`);
    }
  });

  socket.on("attackCell", ({ roomId, x, y }) => {
    const room = rooms.get(String(roomId || "").trim().toUpperCase());
    if (!room) {
      socket.emit("errorMessage", "部屋が見つかりません。");
      return;
    }

    if (room.phase !== "battle") {
      socket.emit("errorMessage", "いまは対戦中ではありません。");
      return;
    }

    const attacker = room.players.find(p => p.socketId === socket.id);
    if (!attacker) {
      socket.emit("errorMessage", "この部屋のプレイヤーではありません。");
      return;
    }

    if (attacker.playerNumber !== room.turn) {
      socket.emit("errorMessage", "あなたのターンではありません。");
      return;
    }

    const defender = room.players.find(p => p.socketId !== socket.id);
    if (!defender) {
      socket.emit("errorMessage", "相手がいません。");
      return;
    }

    if (
      typeof x !== "number" ||
      typeof y !== "number" ||
      x < 0 || x >= room.boardSize ||
      y < 0 || y >= room.boardSize
    ) {
      socket.emit("errorMessage", "座標が不正です。");
      return;
    }

    const cell = defender.ownBoard[y][x];

    if (cell.hit || cell.wave) {
      socket.emit("errorMessage", "そのマスはすでに攻撃済みです。");
      return;
    }

    if (cell.ship) {
      cell.hit = true;
      defender.hitsReceived++;

      socket.emit("attackResult", {
        x, y, result: "hit"
      });

      io.to(defender.socketId).emit("defenseResult", {
        x, y, result: "hit"
      });

      if (defender.hitsReceived >= defender.totalShipCells) {
        room.phase = "finished";
        room.winner = attacker.playerNumber;

        io.to(room.roomId).emit("roomState", getRoomPublicState(room));
        io.to(room.roomId).emit("gameOver", {
          winner: attacker.playerNumber
        });
        return;
      }
    } else if (isAdjacentToShip(defender.ownBoard, x, y, room.boardSize)) {
      cell.wave = true;

      socket.emit("attackResult", {
        x, y, result: "near"
      });

      io.to(defender.socketId).emit("defenseResult", {
        x, y, result: "near"
      });
    } else {
      cell.wave = true;

      socket.emit("attackResult", {
        x, y, result: "miss"
      });

      io.to(defender.socketId).emit("defenseResult", {
        x, y, result: "miss"
      });
    }

    room.turn = defender.playerNumber;
    io.to(room.roomId).emit("roomState", getRoomPublicState(room));
  });

  socket.on("disconnect", () => {
    const room = getPlayerRoom(socket.id);
    if (!room) return;

    room.players = room.players.filter(p => p.socketId !== socket.id);

    if (room.players.length === 0) {
      rooms.delete(room.roomId);
      return;
    }

    room.phase = "waiting";
    room.turn = null;
    room.winner = null;

    for (const p of room.players) {
      p.placementDone = false;
      p.ownBoard = createBoard(room.boardSize);
      p.totalShipCells = 0;
      p.hitsReceived = 0;
    }

    io.to(room.roomId).emit("systemMessage", "相手が切断しました。部屋は待機状態に戻りました。");
    io.to(room.roomId).emit("roomState", getRoomPublicState(room));
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
