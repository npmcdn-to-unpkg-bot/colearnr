'use strict'

const db = require('../common/db')
const _ = require('lodash')
const permlib = require('../lib/perms')
const logger = require('../common/log')
const util = require('../common/util')

exports.list_annotations = function (req, res) {
  let lbit_oid = req.params['lbit_oid']
  let user = req.user
  let userList = [req.user._id]
  let topicId = req.query.topic_id
  let topicObj = null
  let type = req.query.type
  if (type && type === 'pdf') {
    // find the lbit
    db.learnbits.find({_id: db.ObjectId(lbit_oid)}, function (err, lbits) {
      if (!err && lbits.length) {
        let lbit_topics = lbits[0].topics
        let topics = []
        // get all the topics under this lbit
        for (let i = 0; i < lbit_topics.length; i++) {
          topics.push(lbit_topics[i]._id)
        }

        if (topics.length) {
          // for each topic get all the admins and collaborators
          db.topics.find({_id: {$in: topics}}, function (err, topics) {
            if (err) {
              logger.error(err)
            }
            for (let i = 0; i < topics.length; i++) {
              if ('' + topics[i]._id === topicId) {
                topicObj = topics[i]
              }
              userList.push(topics[i].added_by)
              let collaborators = topics[i].collaborators
              if (collaborators) {
                for (let j = 0; j < collaborators.length; j++) {
                  userList.push(collaborators[j])
                }
              }
              userList = _.uniq(userList)
              doListingInDb()
            }
          })
        }
      }
    })
  } else {
    doListingInDb()
  }

  function doListingInDb () {
    logger.log('debug', 'list_annotations lbit_oid', lbit_oid, topicId)
    permlib.checkTopicEditAccess(user, topicObj, function (err, isAllowed) {
      if (err) {
        logger.error(err)
      }
      db.userdata.find({lbit_oid: lbit_oid, type: {$ne: 'notes'}, user: {$in: userList}}, {
        annotationData: 1,
        user: 1
      }, function (err, annotationList) {
        if (err) {
          logger.error(err)
        }
        let annotations = []
        if (annotationList && annotationList.length) {
          for (let i = 0; i < annotationList.length; i++) {
            let obj = annotationList[i].annotationData
            obj.id = '' + annotationList[i]._id
            if (type === 'pdf') {
              obj.readonly = !isAllowed || (annotationList[i].user !== user._id)
              obj.annotationId = '' + annotationList[i]._id
              obj.isUpdate = null
            }
            annotations.push(obj)
          }
        }
        res.send(util.stringify(annotations))
      })
    })
  }
}

exports.save_annotations = function (req, res) {
  let lbit_oid = req.params['lbit_oid']
  let user = req.user
  let annotationData = req.body.annotationData ? req.body.annotationData : req.body
  annotationData.readonly = null
  annotationData.isUpdate = null
  let topicId = req.body.topicId
  let sessionid = req.body.sessionid

  logger.log('debug', 'save_annotations lbit_oid', lbit_oid, topicId, sessionid)
  db.userdata.save({lbit_oid: lbit_oid, user: req.user._id, annotationData: annotationData}, function (err, data) {
    if (err) {
      logger.error(err)
    }
    if (req.body.annotationData) {
      annotationData.annotationId = '' + data._id
    } else {
      annotationData.id = '' + data._id
    }
    res.send(annotationData)
    db.topics.findOne({_id: db.ObjectId(topicId)}, function (err, topicObj) {
      if (!err && req.body.annotationData) {
        permlib.isTopicCollab(user, topicObj, function (err, collaborator) {
          if (!err && collaborator) {
            if (global.socket) {
              global.socket.emit('send:addAnnotation', {
                annotationData: annotationData,
                lbit_id: lbit_oid,
                sessionid: sessionid
              })
            } else {
              logger.log('warn', 'Unable to push the changes to the clients')
            }
            db.learnbits.update({_id: db.ObjectId(lbit_oid)}, {
              $set: {
                last_updated: new Date(),
                modified_by: user._id
              }
            })
          } else {
            permlib.isTopicAdmin(user, topicObj, function (err, admin) {
              if (!err && admin) {
                if (global.socket) {
                  global.socket.emit('send:addAnnotation', {
                    annotationData: annotationData,
                    lbit_id: lbit_oid,
                    sessionid: sessionid
                  })
                } else {
                  logger.log('warn', 'Unable to push the changes to the clients')
                }
                db.learnbits.update({_id: db.ObjectId(lbit_oid)}, {
                  $set: {
                    last_updated: new Date(),
                    modified_by: user._id
                  }
                })
              } else {
                logger.log('debug', user, lbit_oid, 'is neither a collaborator nor admin')
              }
            })
          }
        })
      }
    })
  })
}

exports.delete_annotations = function (req, res) {
  let lbit_oid = req.params['lbit_oid']
  let user = req.user
  let annotationData = req.body.annotationData ? req.body.annotationData : req.body
  let id = annotationData.annotationId || req.params.id
  let topicId = req.body.topicId
  let sessionid = req.body.sessionid
  logger.log('debug', 'delete_annotations lbit_oid', lbit_oid, topicId, sessionid)
  db.topics.findOne({_id: db.ObjectId(topicId)}, function (err, topicObj) {
    if (!err && req.body.annotationData) {
      deleteInDb()
      permlib.isTopicCollab(user, topicObj, function (err, collaborator) {
        if (!err && collaborator) {
          broadcastDelete()
        } else {
          permlib.isTopicAdmin(user, topicObj, function (err, admin) {
            if (!err && admin) {
              broadcastDelete()
            } else {
              logger.log('debug', user, lbit_oid, 'is neither a collaborator nor admin')
            }
          })
        }
      })
    } else {
      deleteInDb()
    }
  })

  function broadcastDelete () {
    if (global.socket) {
      global.socket.emit('send:deleteAnnotation', {
        annotationData: annotationData,
        lbit_id: lbit_oid,
        sessionid: sessionid
      })
    } else {
      logger.log('warn', 'Unable to push the changes to the clients for delete annotataion')
    }
    db.learnbits.update({_id: db.ObjectId(lbit_oid)}, {$set: {last_updated: new Date(), modified_by: user._id}})
  }

  function deleteInDb () {
    logger.log('debug', 'delete_annotations lbit_oid', lbit_oid, id)
    db.userdata.remove({_id: db.ObjectId(id), lbit_oid: lbit_oid})
    res.send('1')
  }
}

exports.update_annotations = function (req, res) {
  let lbit_oid = req.params['lbit_oid']
  let user = req.user
  let id = req.params['id']
  let annotationData = req.body.annotationData ? req.body.annotationData : req.body
  annotationData.readonly = null
  annotationData.isUpdate = null
  annotationData.annotationId = id
  let topicId = req.body.topicId
  let sessionid = req.body.sessionid
  logger.log('debug', 'update_annotations lbit_oid', lbit_oid, topicId, sessionid)
  db.topics.findOne({_id: db.ObjectId(topicId)}, function (err, topicObj) {
    if (!err && req.body.annotationData) {
      updateInDb()
      permlib.isTopicCollab(user, topicObj, function (err, collaborator) {
        if (!err && collaborator) {
          broadcastUpdate()
        } else {
          permlib.isTopicAdmin(user, topicObj, function (err, admin) {
            if (!err && admin) {
              broadcastUpdate()
            } else {
              logger.log('debug', user, lbit_oid, 'is neither a collaborator nor admin')
            }
          })
        }
      })
    } else {
      updateInDb()
    }
  })

  function broadcastUpdate () {
    if (global.socket) {
      global.socket.emit('send:updateAnnotation', {
        annotationData: annotationData,
        lbit_id: lbit_oid,
        sessionid: sessionid
      })
    } else {
      logger.log('warn', 'Unable to push the changes to the clients for update annotataion')
    }
    db.learnbits.update({_id: db.ObjectId(lbit_oid)}, {$set: {last_updated: new Date(), modified_by: user._id}})
  }

  function updateInDb () {
    logger.log('debug', 'update_annotations lbit_oid', lbit_oid)
    db.userdata.update({_id: db.ObjectId(id)}, {$set: {annotationData: annotationData}})
    res.send(annotationData)
  }
}

exports.search_annotations = function (req, res) {
  let lbit_oid = req.params['lbit_oid']
  logger.log('debug', 'search lbit_oid', lbit_oid)
  db.userdata.find({lbit_oid: lbit_oid, type: {$ne: 'notes'}, user: req.user._id}, {annotationData: 1}, function (err, annotationList) {
    let annotations = []
    if (!err && annotationList && annotationList.length) {
      for (let i = 0; i < annotationList.length; i++) {
        let obj = annotationList[i]['annotationData']
        obj['id'] = '' + annotationList[i]['_id']
        annotations.push(obj)
      }
    }
    // logger.log('debug', 'Returning annotations', annotations)
    res.send(util.stringify(annotations))
  })
}

exports.list_notes = function (req, res) {
  let lbit_oid = req.params.lbit_oid
  let user = req.user
  let topic_oid = req.query.topic_id
  db.userdata.findOne({lbit_oid: lbit_oid, user: user._id, type: 'notes'}, function (err, currNoteObj) {
    if (!err && !currNoteObj) {
      // Create an empty note and send it
      saveNotes(lbit_oid, topic_oid, user, '', function (err, noteObj) {
        if (err) {
          logger.error(err)
        }
        res.render('lbits/lbit-notes.ejs', {id: noteObj._id, data: noteObj.data, user: user, lbit_oid: lbit_oid, topic_oid: topic_oid})
      })
    } else {
      res.render('lbits/lbit-notes.ejs', {id: currNoteObj._id, noteObj: currNoteObj, data: currNoteObj.data, user: user, lbit_oid: lbit_oid, topic_oid: topic_oid})
    }
  })
}

let saveNotes = function (lbit_oid, topic_oid, user, data, callback) {
  if (data && data._id) {
    // logger.log('debug', 'Updated notes', lbit_oid, topic_oid, user._id)
    db.userdata.save({_id: db.ObjectId(data._id), lbit_oid: lbit_oid, user: user._id, type: 'notes', data: data}, callback)
  } else {
    db.userdata.findOne({lbit_oid: lbit_oid, user: user._id, type: 'notes'}, function (err, currNotesObj) {
      if (!err && currNotesObj) {
        currNotesObj.data = data
        currNotesObj.last_updated = new Date()
        currNotesObj.modified_by = user._id
        // logger.log('debug', 'Updated notes', lbit_oid, topic_oid, user._id)
        db.userdata.save(currNotesObj, callback)
      } else {
        // logger.log('debug', 'New notes', lbit_oid, topic_oid, user._id)
        db.userdata.save({lbit_oid: lbit_oid, user: user._id, type: 'notes', data: data}, callback)
      }
    })
  }
}

exports.save_notes = function (req, res) {
  let lbit_oid = req.params.lbit_oid
  let user = req.user
  let topic_oid = req.query.topic_id
  let data = req.body.data
  res.send('1')
  saveNotes(lbit_oid, topic_oid, user, data, function (err, noteObj) {
    if (err) {
      logger.error(err)
    }
  // logger.log('debug', 'Saved notes', noteObj)
  })
}
