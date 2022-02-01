
const child_process = require('child_process')
const axios = require('axios')
const fs = require('fs')
const net = require('net')
const path = require('path')
const cbor = require('cbor')

async function Walk(dir, cb) {
	let files = await fs.promises.readdir(dir)
	for (let file of files) {
		let file_path = path.join(dir, file)
		let stat = await fs.promises.stat(file_path)
		if (stat.isDirectory()) {
			await Walk(file_path, cb)
		} else {
			cb(file_path)
		}
	}
}


module.exports.Walk = Walk

module.exports.RunProcess = function(cmd, args) {
	return new Promise(function(resolve, reject) {
		let p = child_process.spawn(cmd, args)
		let stdout = ''
		let stderr = ''
		p.stdout.on('data', data => {
			stdout += data
			// console.log("TESTO OUT: ", data.toString('utf8'))
		})
		p.stderr.on('data', data => {
			stderr += data
			// console.log("TESTO ERR: ", data.toString('utf8'))
		})
		p.on('exit', code => {
			if (code > 1) {
				reject(stderr)
			} else {
				resolve(stdout)
			}
		})
		p.on('error', error => reject(error))
	})
}

function Sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports.SuperAxios = async function(generate_args) {
	let interval = 10
	while (true) {
		let args = generate_args()
		try {
			return await axios(args)
		} catch (error) {
			process.stdout.write(`Failed to ${args.method} url ${args.url}. ${error}. `)
			process.stdout.write(`I'll try again in ${interval} seconds.\n`)
			await Sleep(interval * 1000)
		}
	}
}

class Task {
	constructor() {
		this.promise = new Promise((resolve, reject)=> {
			this.reject = reject
			this.resolve = resolve
		})
	}
}

class ReadTask extends Task {
	constructor(size) {
		super()
		this.size = size
	}
}

class ReportReader {
	constructor(socket) {
		this.socket = socket
		this.closed = false
		this.buffer = null
		this.read_task = null
		socket.on('data', data => {
			if (this.buffer) {
				this.buffer = Buffer.concat([this.buffer, data])
			} else {
				this.buffer = data
			}
			if (this.read_task && this.read_task.size <= this.buffer.length) {
				this.read_task.resolve(this.doRead(this.read_task.size))
				this.read_task = null
			}
		});
		socket.on('close', () => {
			this.closed = true
		});
	}

	doRead(size) {
		let result = this.buffer.slice(0, size)
		this.buffer = this.buffer.slice(size)
		return result
	}

	async read(size) {
		if (this.closed) {
			throw "Can't read from a socket because Testo interpreter has closed a tcp connection"
		}
		if (this.read_task) {
			throw "already has a pending read task"
		}
		if (this.buffer && this.buffer.length >= size) {
			return this.doRead(size)
		} else {
			this.read_task = new ReadTask(size)
			return await this.read_task.promise
		}
	}

	async write(data) {
		if (this.closed) {
			throw "Can't write to a socket because Testo interpreter has closed a tcp connection"
		}
		return new Promise((resolve, reject) => {
			this.socket.write(data, (error) => {
				if (error) {
					reject(error)
				} else {
					resolve()
				}
			})
		})
	}

	async readInt() {
		let buf = await this.read(4)
		return buf.readInt32LE()
	}

	async recv() {
		let size = await this.readInt()
		let buf = await this.read(size)
		return cbor.decodeFirst(buf)
	}

	async send(json) {
		let data = cbor.encode(json)
		let data_len = Buffer.alloc(4)
		data_len.writeInt32LE(data.length)
		await this.write(data_len)
		await this.write(data)
	}
};

async function CreateTcpServer() {
	console.log(`Creating tcp server to accept connection from testo ...`);

	return new Promise(function(resolve, reject) {
		let server = net.createServer()
		let accept_tasks = []
		server.accept = async function() {
			let task = new Task()
			accept_tasks.push(task)
			return task.promise
		}
		server.on('connection', function(socket) {
			let task = accept_tasks.shift()
			if (task) {
				task.resolve(new ReportReader(socket));
			}
		})
		server.listen({backlog: 1, host: 'localhost', port: 0}, (error) => {
			if (error) {
				reject(error)
			} else {
				resolve(server)
			}
		})
	})
}

module.exports.CreateTcpServer = CreateTcpServer