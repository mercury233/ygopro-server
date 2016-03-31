// Generated by CoffeeScript 1.10.0
(function() {
  var Room, _, bunyan, get_memory_usage, log, moment, redis, redisdb, roomlist, settings, spawn, spawnSync, ygopro, zlib;

  _ = require('underscore');

  _.str = require('underscore.string');

  _.mixin(_.str.exports());

  spawn = require('child_process').spawn;

  spawnSync = require('child_process').spawnSync;

  settings = require('./config.json');

  ygopro = require('./ygopro.js');

  if (settings.modules.enable_websocket_roomlist) {
    roomlist = require('./roomlist');
  }

  bunyan = require('bunyan');

  moment = require('moment');

  moment.locale('zh-cn', {
    relativeTime: {
      future: '%s内',
      past: '%s前',
      s: '%d秒',
      m: '1分钟',
      mm: '%d分钟',
      h: '1小时',
      hh: '%d小时',
      d: '1天',
      dd: '%d天',
      M: '1个月',
      MM: '%d个月',
      y: '1年',
      yy: '%d年'
    }
  });

  log = bunyan.createLogger({
    name: "mycard-room"
  });

  if (settings.modules.enable_cloud_replay) {
    redis = require('redis');
    zlib = require('zlib');
    redisdb = redis.createClient({
      host: "127.0.0.1",
      port: settings.modules.redis_port
    });
  }

  get_memory_usage = function() {
    var actualFree, buffers, cached, free, line, lines, percentUsed, prc_free, total;
    prc_free = spawnSync("free", []);
    if (prc_free.stdout) {
      lines = prc_free.stdout.toString().split(/\n/g);
      line = lines[1].split(/\s+/);
      total = parseInt(line[1], 10);
      free = parseInt(line[3], 10);
      buffers = parseInt(line[5], 10);
      cached = parseInt(line[6], 10);
      actualFree = free + buffers + cached;
      percentUsed = parseFloat(((1 - (actualFree / total)) * 100).toFixed(2));
    } else {
      percentUsed = 0;
    }
    return percentUsed;
  };

  Room = (function() {
    Room.all = [];

    Room.players_oppentlist = {};

    Room.players_banned = [];

    Room.ban_player = function(name, ip, reason) {
      var bannedplayer, bantime;
      bannedplayer = _.find(Room.players_banned, function(bannedplayer) {
        return ip === bannedplayer.ip;
      });
      if (bannedplayer) {
        bannedplayer.count = bannedplayer.count + 1;
        bantime = bannedplayer.count > 3 ? Math.pow(2, bannedplayer.count - 3) * 2 : 0;
        bannedplayer.time = moment() < bannedplayer.time ? moment(bannedplayer.time).add(bantime, 'm') : moment().add(bantime, 'm');
        if (!_.find(bannedplayer.reasons, function(bannedreason) {
          return bannedreason === reason;
        })) {
          bannedplayer.reasons.push(reason);
        }
        bannedplayer.need_tip = true;
      } else {
        bannedplayer = {
          "ip": ip,
          "time": moment(),
          "count": 1,
          "reasons": [reason],
          "need_tip": true
        };
        Room.players_banned.push(bannedplayer);
      }
      log.info("banned", name, ip, reason, bannedplayer.count);
    };

    Room.find_or_create_by_name = function(name, player_ip) {
      var room;
      if (settings.modules.enable_random_duel && (name === '' || name.toUpperCase() === 'S' || name.toUpperCase() === 'M' || name.toUpperCase() === 'T')) {
        return this.find_or_create_random(name.toUpperCase(), player_ip);
      }
      if (room = this.find_by_name(name)) {
        return room;
      } else if (get_memory_usage() >= 90) {
        return null;
      } else {
        return new Room(name);
      }
    };

    Room.find_or_create_random = function(type, player_ip) {
      var bannedplayer, max_player, name, playerbanned, result;
      bannedplayer = _.find(Room.players_banned, function(bannedplayer) {
        return player_ip === bannedplayer.ip;
      });
      if (bannedplayer) {
        if (bannedplayer.count > 6 && moment() < bannedplayer.time) {
          return {
            "error": "因为您近期在游戏中多次" + (bannedplayer.reasons.join('、')) + "，您已被禁止使用随机对战功能，将在" + (moment(bannedplayer.time).fromNow(true)) + "后解封"
          };
        }
        if (bannedplayer.count > 3 && moment() < bannedplayer.time && bannedplayer.need_tip) {
          bannedplayer.need_tip = false;
          return {
            "error": "因为您近期在游戏中" + (bannedplayer.reasons.join('、')) + "，在" + (moment(bannedplayer.time).fromNow(true)) + "内您随机对战时只能遇到其他违规玩家"
          };
        } else if (bannedplayer.need_tip) {
          bannedplayer.need_tip = false;
          return {
            "error": "系统检测到您近期在游戏中" + (bannedplayer.reasons.join('、')) + "，若您违规超过3次，将受到惩罚"
          };
        } else if (bannedplayer.count > 2) {
          bannedplayer.need_tip = true;
        }
      }
      max_player = type === 'T' ? 4 : 2;
      playerbanned = bannedplayer && bannedplayer.count > 3 && moment() < bannedplayer.time;
      result = _.find(this.all, function(room) {
        return room.random_type !== '' && !room.started && ((type === '' && room.random_type !== 'T') || room.random_type === type) && room.get_playing_player().length < max_player && (room.get_host() === null || room.get_host().remoteAddress !== Room.players_oppentlist[player_ip]) && (playerbanned === room.deprecated);
      });
      if (result) {
        result.welcome = '对手已经在等你了，开始决斗吧！';
      } else {
        type = type ? type : 'S';
        name = type + ',RANDOM#' + Math.floor(Math.random() * 100000);
        result = new Room(name);
        result.random_type = type;
        result.max_player = max_player;
        result.welcome = '已建立随机对战房间，正在等待对手！';
        result.deprecated = playerbanned;
      }
      return result;
    };

    Room.find_by_name = function(name) {
      var result;
      result = _.find(this.all, function(room) {
        return room.name === name;
      });
      return result;
    };

    Room.find_by_port = function(port) {
      return _.find(this.all, function(room) {
        return room.port === port;
      });
    };

    Room.validate = function(name) {
      var client_name, client_name_and_pass, client_pass;
      client_name_and_pass = name.split('$', 2);
      client_name = client_name_and_pass[0];
      client_pass = client_name_and_pass[1];
      if (!client_pass) {
        return true;
      }
      return !_.find(Room.all, function(room) {
        var room_name, room_name_and_pass, room_pass;
        room_name_and_pass = room.name.split('$', 2);
        room_name = room_name_and_pass[0];
        room_pass = room_name_and_pass[1];
        return client_name === room_name && client_pass !== room_pass;
      });
    };

    function Room(name, hostinfo) {
      var draw_count, error1, lflist, param, rule, start_hand, start_lp, time_limit;
      this.hostinfo = hostinfo;
      this.name = name;
      this.alive = true;
      this.players = [];
      this.player_datas = [];
      this.status = 'starting';
      this.started = false;
      this.established = false;
      this.watcher_buffers = [];
      this.recorder_buffers = [];
      this.watchers = [];
      this.random_type = '';
      this.welcome = '';
      Room.all.push(this);
      this.hostinfo || (this.hostinfo = {
        lflist: _.findIndex(settings.lflist, function(list) {
          return !list.tcg && list.date.isBefore();
        }),
        rule: settings.modules.enable_TCG_as_default ? 2 : 0,
        mode: 0,
        enable_priority: false,
        no_check_deck: false,
        no_shuffle_deck: false,
        start_lp: 8000,
        start_hand: 5,
        draw_count: 1,
        time_limit: 180
      });
      if (name.slice(0, 2) === 'M#') {
        this.hostinfo.mode = 1;
      } else if (name.slice(0, 2) === 'T#') {
        this.hostinfo.mode = 2;
        this.hostinfo.start_lp = 16000;
      } else if ((param = name.match(/^(\d)(\d)(T|F)(T|F)(T|F)(\d+),(\d+),(\d+)/i))) {
        this.hostinfo.rule = parseInt(param[1]);
        this.hostinfo.mode = parseInt(param[2]);
        this.hostinfo.enable_priority = param[3] === 'T';
        this.hostinfo.no_check_deck = param[4] === 'T';
        this.hostinfo.no_shuffle_deck = param[5] === 'T';
        this.hostinfo.start_lp = parseInt(param[6]);
        this.hostinfo.start_hand = parseInt(param[7]);
        this.hostinfo.draw_count = parseInt(param[8]);
      } else if (((param = name.match(/(.+)#/)) !== null) && ((param[1].length <= 2 && param[1].match(/(S|N|M|T)(0|1|2|T|A)/i)) || (param[1].match(/^(S|N|M|T)(0|1|2|O|T|A)(0|1|O|T)/i)))) {
        rule = param[1].toUpperCase();
        switch (rule.charAt(0)) {
          case "M":
          case "1":
            this.hostinfo.mode = 1;
            break;
          case "T":
          case "2":
            this.hostinfo.mode = 2;
            this.hostinfo.start_lp = 16000;
            break;
          default:
            this.hostinfo.mode = 0;
        }
        switch (rule.charAt(1)) {
          case "0":
          case "O":
            this.hostinfo.rule = 0;
            break;
          case "1":
          case "T":
            this.hostinfo.rule = 1;
            break;
          default:
            this.hostinfo.rule = 2;
        }
        switch (rule.charAt(2)) {
          case "1":
          case "T":
            this.hostinfo.lflist = _.findIndex(settings.lflist, function(list) {
              return list.tcg && list.date.isBefore();
            });
            break;
          default:
            this.hostinfo.lflist = _.findIndex(settings.lflist, function(list) {
              return !list.tcg && list.date.isBefore();
            });
        }
        if ((param = parseInt(rule.charAt(3).match(/\d/))) >= 0) {
          this.hostinfo.time_limit = param * 60;
        }
        switch (rule.charAt(4)) {
          case "T":
          case "1":
            this.hostinfo.enable_priority = true;
            break;
          default:
            this.hostinfo.enable_priority = false;
        }
        switch (rule.charAt(5)) {
          case "T":
          case "1":
            this.hostinfo.no_check_deck = true;
            break;
          default:
            this.hostinfo.no_check_deck = false;
        }
        switch (rule.charAt(6)) {
          case "T":
          case "1":
            this.hostinfo.no_shuffle_deck = true;
            break;
          default:
            this.hostinfo.no_shuffle_deck = false;
        }
        if ((param = parseInt(rule.charAt(7).match(/\d/))) > 0) {
          this.hostinfo.start_lp = param * 4000;
        }
        if ((param = parseInt(rule.charAt(8).match(/\d/))) > 0) {
          this.hostinfo.start_hand = param;
        }
        if ((param = parseInt(rule.charAt(9).match(/\d/))) >= 0) {
          this.hostinfo.draw_count = param;
        }
      } else if ((param = name.match(/(.+)#/)) !== null) {
        rule = param[1].toUpperCase();
        if (rule.match(/(^|，|,)(M|MATCH)(，|,|$)/)) {
          this.hostinfo.mode = 1;
        }
        if (rule.match(/(^|，|,)(T|TAG)(，|,|$)/)) {
          this.hostinfo.mode = 2;
          this.hostinfo.start_lp = 16000;
        }
        if (rule.match(/(^|，|,)(TCGONLY|TO)(，|,|$)/)) {
          this.hostinfo.rule = 1;
          this.hostinfo.lflist = _.findIndex(settings.lflist, function(list) {
            return list.tcg && list.date.isBefore();
          });
        }
        if (rule.match(/(^|，|,)(OCGONLY|OO)(，|,|$)/)) {
          this.hostinfo.rule = 0;
        }
        if (rule.match(/(^|，|,)(OT|TCG)(，|,|$)/)) {
          this.hostinfo.rule = 2;
        }
        if ((param = rule.match(/(^|，|,)LP(\d+)(，|,|$)/))) {
          start_lp = parseInt(param[2]);
          if (start_lp <= 0) {
            start_lp = 1;
          }
          if (start_lp >= 99999) {
            start_lp = 99999;
          }
          this.hostinfo.start_lp = start_lp;
        }
        if ((param = rule.match(/(^|，|,)(TIME|TM|TI)(\d+)(，|,|$)/))) {
          time_limit = parseInt(param[3]);
          if (time_limit < 0) {
            time_limit = 180;
          }
          if (time_limit >= 1 && time_limit <= 60) {
            time_limit = time_limit * 60;
          }
          if (time_limit >= 999) {
            time_limit = 999;
          }
          this.hostinfo.time_limit = time_limit;
        }
        if ((param = rule.match(/(^|，|,)(START|ST)(\d+)(，|,|$)/))) {
          start_hand = parseInt(param[3]);
          if (start_hand <= 0) {
            start_hand = 1;
          }
          if (start_hand >= 40) {
            start_hand = 40;
          }
          this.hostinfo.start_hand = start_hand;
        }
        if ((param = rule.match(/(^|，|,)(DRAW|DR)(\d+)(，|,|$)/))) {
          draw_count = parseInt(param[3]);
          if (draw_count >= 35) {
            draw_count = 35;
          }
          this.hostinfo.draw_count = draw_count;
        }
        if ((param = rule.match(/(^|，|,)(LFLIST|LF)(\d+)(，|,|$)/))) {
          lflist = parseInt(param[3]) - 1;
          this.hostinfo.lflist = lflist;
        }
        if (rule.match(/(^|，|,)(NOLFLIST|NF)(，|,|$)/)) {
          this.hostinfo.lflist = -1;
        }
        if (rule.match(/(^|，|,)(NOUNIQUE|NU)(，|,|$)/)) {
          this.hostinfo.rule = 3;
        }
        if (rule.match(/(^|，|,)(NOCHECK|NC)(，|,|$)/)) {
          this.hostinfo.no_check_deck = true;
        }
        if (rule.match(/(^|，|,)(NOSHUFFLE|NS)(，|,|$)/)) {
          this.hostinfo.no_shuffle_deck = true;
        }
        if (rule.match(/(^|，|,)(IGPRIORITY|PR)(，|,|$)/)) {
          this.hostinfo.enable_priority = true;
        }
      }
      param = [0, this.hostinfo.lflist, this.hostinfo.rule, this.hostinfo.mode, (this.hostinfo.enable_priority ? 'T' : 'F'), (this.hostinfo.no_check_deck ? 'T' : 'F'), (this.hostinfo.no_shuffle_deck ? 'T' : 'F'), this.hostinfo.start_lp, this.hostinfo.start_hand, this.hostinfo.draw_count, this.hostinfo.time_limit];
      try {
        this.process = spawn('./ygopro', param, {
          cwd: settings.ygopro_path
        });
        this.process.on('exit', (function(_this) {
          return function(code) {
            if (!_this.disconnector) {
              _this.disconnector = 'server';
            }
            _this["delete"]();
          };
        })(this));
        this.process.stdout.setEncoding('utf8');
        this.process.stdout.once('data', (function(_this) {
          return function(data) {
            _this.established = true;
            if (!_this["private"] && settings.modules.enable_websocket_roomlist) {
              roomlist.create(_this);
            }
            _this.port = parseInt(data);
            _.each(_this.players, function(player) {
              player.server.connect(_this.port, '127.0.0.1', function() {
                var buffer, i, len, ref;
                ref = player.pre_establish_buffers;
                for (i = 0, len = ref.length; i < len; i++) {
                  buffer = ref[i];
                  player.server.write(buffer);
                }
                player.established = true;
                player.pre_establish_buffers = [];
              });
            });
            if (_this.windbot) {
              _this.ai_process = spawn('mono', ['WindBot.exe'], {
                cwd: 'windbot',
                env: {
                  YGOPRO_VERSION: settings.version,
                  YGOPRO_HOST: '127.0.0.1',
                  YGOPRO_PORT: _this.port,
                  YGOPRO_NAME: _this.windbot.name,
                  YGOPRO_DECK: _this.windbot.deck,
                  YGOPRO_DIALOG: _this.windbot.dialog
                }
              });
              _this.ai_process.stdout.on('data', function(data) {});
              _this.ai_process.stderr.on('data', function(data) {
                log.info("AI stderr: " + data);
              });
            }
          };
        })(this));
      } catch (error1) {
        this.error = "建立房间失败，请重试";
      }
    }

    Room.prototype["delete"] = function() {
      var index, player_ips, player_names, recorder_buffer;
      if (this.deleted) {
        return;
      }
      if (this.player_datas.length && settings.modules.enable_cloud_replay) {
        player_names = this.player_datas[0].name + (this.player_datas[2] ? "+" + this.player_datas[2].name : "") + " VS " + (this.player_datas[1] ? this.player_datas[1].name : "AI") + (this.player_datas[3] ? "+" + this.player_datas[3].name : "");
        player_ips = [];
        _.each(this.player_datas, (function(_this) {
          return function(player) {
            player_ips.push(player.ip);
          };
        })(this));
        recorder_buffer = Buffer.concat(this.recorder_buffers);
        zlib.deflate(recorder_buffer, (function(_this) {
          return function(err, replay_buffer) {
            var date_time, recorded_ip, replay_id;
            replay_buffer = replay_buffer.toString('binary');
            date_time = moment().format('YYYY-MM-DD HH:mm:ss');
            replay_id = Math.floor(Math.random() * 100000000);
            redisdb.hmset("replay:" + replay_id, "replay_id", replay_id, "replay_buffer", replay_buffer, "player_names", player_names, "date_time", date_time);
            redisdb.expire("replay:" + replay_id, 60 * 60 * 24);
            recorded_ip = [];
            _.each(player_ips, function(player_ip) {
              if (_.contains(recorded_ip, player_ip)) {
                return;
              }
              recorded_ip.push(player_ip);
              redisdb.lpush(player_ip + ":replays", replay_id);
            });
          };
        })(this));
      }
      this.watcher_buffers = [];
      this.recorder_buffers = [];
      this.players = [];
      if (this.watcher) {
        this.watcher.end();
      }
      this.deleted = true;
      index = _.indexOf(Room.all, this);
      if (index !== -1) {
        Room.all.splice(index, 1);
      }
      if (!this["private"] && !this.started && this.established && settings.modules.enable_websocket_roomlist) {
        roomlist["delete"](this.name);
      }
    };

    Room.prototype.get_playing_player = function() {
      var playing_player;
      playing_player = [];
      _.each(this.players, (function(_this) {
        return function(player) {
          if (player.pos < 4) {
            playing_player.push(player);
          }
        };
      })(this));
      return playing_player;
    };

    Room.prototype.get_host = function() {
      var host_player;
      host_player = null;
      _.each(this.players, (function(_this) {
        return function(player) {
          if (player.is_host) {
            host_player = player;
          }
        };
      })(this));
      return host_player;
    };

    Room.prototype.connect = function(client) {
      var host_player;
      this.players.push(client);
      client.ip = client.remoteAddress;
      if (this.random_type) {
        host_player = this.get_host();
        if (host_player && (host_player !== client)) {
          Room.players_oppentlist[host_player.remoteAddress] = client.remoteAddress;
          Room.players_oppentlist[client.remoteAddress] = host_player.remoteAddress;
        } else {
          Room.players_oppentlist[client.remoteAddress] = null;
        }
      }
      if (this.established) {
        if (!this["private"] && !this.started && settings.modules.enable_websocket_roomlist) {
          roomlist.update(this);
        }
        client.server.connect(this.port, '127.0.0.1', function() {
          var buffer, i, len, ref;
          ref = client.pre_establish_buffers;
          for (i = 0, len = ref.length; i < len; i++) {
            buffer = ref[i];
            client.server.write(buffer);
          }
          client.established = true;
          client.pre_establish_buffers = [];
        });
      }
    };

    Room.prototype.disconnect = function(client, error) {
      var index;
      if (client.is_post_watcher) {
        ygopro.stoc_send_chat_to_room(this, client.name + " " + '退出了观战' + (error ? ": " + error : ''));
        index = _.indexOf(this.watchers, client);
        if (index !== -1) {
          this.watchers.splice(index, 1);
        }
      } else {
        index = _.indexOf(this.players, client);
        if (index !== -1) {
          this.players.splice(index, 1);
        }
        if (this.started && this.disconnector !== 'server' && client.room.random_type) {
          Room.ban_player(client.name, client.ip, "强退");
        }
        if (this.players.length) {
          ygopro.stoc_send_chat_to_room(this, client.name + " " + '离开了游戏' + (error ? ": " + error : ''));
          if (!this["private"] && !this.started && settings.modules.enable_websocket_roomlist) {
            roomlist.update(this);
          }
        } else {
          this.process.kill();
          this["delete"]();
        }
      }
    };

    return Room;

  })();

  module.exports = Room;

}).call(this);
