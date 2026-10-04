-- One-time upgrade of current Beijing rule bindings. Published definitions and
-- frozen proceedings remain unchanged. The runner executes this in one transaction.
LOCK TABLE committees, meeting_sessions, rule_packages, rule_package_versions IN EXCLUSIVE MODE;

-- Startup installs built-ins after migrations, so older installations need the
-- complete, frozen v12 definition here rather than a transformation of an old rule.
INSERT INTO rule_package_versions
  (id,package_id,version,status,definition,schema_version,validation_result,published_at)
SELECT gen_random_uuid(),p.id,12,'PUBLISHED',$beijing_v12$
{
  "schemaVersion": 1,
  "key": "builtin:beijing-academic",
  "metadata": {
    "defaultLanguage": "zh-CN",
    "names": {
      "zh-CN": "北京学术标准 2021",
      "en": "Beijing Academic Standard 2021"
    },
    "description": {
      "zh-CN": "阶段 0 已确认差异；新增学术参数须经审阅后以新版本发布。",
      "en": "Confirmed phase 0 differences; further academic parameters require review and a new version."
    }
  },
  "meeting": {
    "operationMode": {
      "defaultValue": "CHAIR_OPERATED"
    }
  },
  "attendance": {
    "responses": [
      "PRESENT",
      "ABSENT"
    ],
    "quorum": {
      "formula": {
        "op": "ceil",
        "value": {
          "op": "multiply",
          "left": {
            "fact": "attendance.allVotingSeatCount"
          },
          "right": 0.25
        }
      }
    },
    "simpleMajority": {
      "formula": {
        "op": "ceil",
        "value": {
          "op": "multiply",
          "left": {
            "fact": "attendance.presentVotingSeatCount"
          },
          "right": 0.5
        }
      }
    },
    "twoThirdsMajority": {
      "formula": {
        "op": "ceil",
        "value": {
          "op": "multiply",
          "left": {
            "fact": "attendance.presentVotingSeatCount"
          },
          "right": 0.6666666667
        }
      }
    }
  },
  "phases": [
    {
      "id": "formal-debate",
      "names": {
        "zh-CN": "正式辩论",
        "en": "Formal Debate"
      }
    }
  ],
  "speakerLists": [
    {
      "id": "general-speakers-list",
      "defaultDurationSeconds": 120,
      "allowDelegateRequests": false,
      "yieldMinimumRemainingSecondsExclusive": 1,
      "yieldTypes": [
        "CHAIR",
        "DELEGATE",
        "QUESTION",
        "COMMENT"
      ],
      "allowRepeatedYield": false
    },
    {
      "id": "moderated-caucus",
      "defaultTotalDurationSeconds": 600,
      "defaultSpeakerDurationSeconds": 60,
      "closeWhenFullSpeechNoLongerFits": true
    }
  ],
  "points": [
    {
      "id": "point-of-order",
      "names": {
        "zh-CN": "程序性问题",
        "en": "Point of Order"
      },
      "interruptRequested": true
    },
    {
      "id": "point-of-information",
      "names": {
        "zh-CN": "咨询性问题",
        "en": "Point of Information"
      },
      "interruptRequested": false
    },
    {
      "id": "point-of-personal-privilege",
      "names": {
        "zh-CN": "个人特权问题",
        "en": "Point of Personal Privilege"
      },
      "interruptRequested": true
    }
  ],
  "motions": [
    {
      "id": "open-moderated-caucus",
      "names": {
        "zh-CN": "开启有主持核心磋商",
        "en": "Open Moderated Caucus"
      },
      "procedural": true,
      "effects": [
        {
          "type": "CREATE_CAUCUS"
        }
      ]
    },
    {
      "id": "open-unmoderated-caucus",
      "names": {
        "zh-CN": "开启自由磋商",
        "en": "Open Unmoderated Caucus"
      },
      "procedural": true,
      "effects": [
        {
          "type": "START_TIMER"
        }
      ]
    },
    {
      "id": "introduce-draft-resolution",
      "names": {
        "zh-CN": "介绍决议草案",
        "en": "Introduce Draft Resolution"
      },
      "requiredSecondCount": 0,
      "effects": [
        {
          "type": "SET_DOCUMENT_STATUS"
        }
      ]
    },
    {
      "id": "postpone-resolution",
      "effects": [
        {
          "type": "SET_DOCUMENT_STATUS"
        }
      ],
      "names": {
        "zh-CN": "延置决议草案",
        "en": "Postpone Draft Resolution"
      }
    },
    {
      "id": "resume-resolution",
      "effects": [
        {
          "type": "SET_DOCUMENT_STATUS"
        }
      ],
      "names": {
        "zh-CN": "取消延置决议草案",
        "en": "Resume the Draft Resolution"
      }
    },
    {
      "id": "vote-on-resolution",
      "names": {
        "zh-CN": "对决议草案投票",
        "en": "Vote on Draft Resolution"
      },
      "effects": [
        {
          "type": "START_BALLOT"
        }
      ]
    },
    {
      "id": "introduce-amendment",
      "names": {
        "zh-CN": "介绍修正案",
        "en": "Introduce Amendment"
      },
      "effects": [
        {
          "type": "SET_DOCUMENT_STATUS"
        }
      ]
    },
    {
      "id": "vote-on-amendment",
      "names": {
        "zh-CN": "对修正案投票",
        "en": "Vote on Amendment"
      },
      "effects": [
        {
          "type": "START_BALLOT"
        }
      ]
    },
    {
      "id": "open-debate",
      "names": {
        "zh-CN": "开启正式辩论",
        "en": "Open Formal Debate"
      },
      "procedural": true,
      "effects": [
        {
          "type": "OPEN_DISCUSSION"
        }
      ]
    },
    {
      "id": "suspend-meeting",
      "names": {
        "zh-CN": "暂停会议",
        "en": "Suspend the meeting"
      },
      "procedural": true,
      "effects": [
        {
          "type": "OPEN_DISCUSSION"
        }
      ]
    },
    {
      "id": "close-debate",
      "names": {
        "zh-CN": "结束正式辩论",
        "en": "Close Formal Debate"
      },
      "procedural": true,
      "effects": [
        {
          "type": "OPEN_DISCUSSION"
        }
      ]
    },
    {
      "id": "adjourn-meeting",
      "names": {
        "zh-CN": "休会",
        "en": "Adjourn the meeting"
      },
      "procedural": true,
      "effects": [
        {
          "type": "OPEN_DISCUSSION"
        }
      ]
    },
    {
      "id": "reorder-draft-resolutions",
      "names": {
        "zh-CN": "调整决议草案顺序",
        "en": "Reorder Draft Resolutions"
      },
      "effects": [
        {
          "type": "SET_DOCUMENT_STATUS"
        }
      ]
    },
    {
      "id": "propose-strawpoll",
      "names": {
        "zh-CN": "提出意向性投票",
        "en": "Propose Strawpoll"
      },
      "effects": [
        {
          "type": "START_BALLOT"
        }
      ]
    },
    {
      "id": "introduce-working-paper",
      "names": {
        "zh-CN": "介绍工作文件",
        "en": "Introduce Working Paper"
      },
      "effects": [
        {
          "type": "START_TIMER"
        }
      ]
    }
  ],
  "ballots": {
    "delegateMayChangeVote": false,
    "chairMayCorrectVote": true,
    "anonymousStrawpoll": false,
    "mustCollectAllVotesWhenVetoSeatEligible": true
  },
  "documents": {
    "amendmentsPublicByDefault": false
  },
  "terminology": {}
}
$beijing_v12$::jsonb,1,'{"valid":true,"issues":[]}'::jsonb,now()
FROM rule_packages p
WHERE p.scope='BUILTIN' AND p.stable_key='builtin:beijing-academic'
ON CONFLICT (package_id,version) DO NOTHING;

DO $$
DECLARE
  target record;
  previous_sessions jsonb;
  event_sequence bigint;
  next_revision integer;
BEGIN
  FOR target IN
    SELECT c.id,c.active_rule_package_version_id AS previous_version_id,new.id AS version_id,p.id AS package_id
    FROM committees c
    JOIN rule_package_versions old ON old.id=c.active_rule_package_version_id
    JOIN rule_packages p ON p.id=old.package_id
    JOIN rule_package_versions new ON new.package_id=p.id AND new.version=12 AND new.status='PUBLISHED'
    WHERE p.scope='BUILTIN' AND p.stable_key='builtin:beijing-academic'
      AND old.status='PUBLISHED' AND old.version<=12 AND c.status IN ('ACTIVE','PAUSED')
      AND (old.version<12 OR EXISTS (
        SELECT 1 FROM meeting_sessions s JOIN rule_package_versions v ON v.id=s.active_rule_package_version_id
        WHERE s.committee_id=c.id AND s.status IN ('OPEN','PENDING')
          AND v.package_id=p.id AND v.status='PUBLISHED' AND v.version<12
      ))
    ORDER BY c.id
  LOOP
    SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id,'versionId',s.active_rule_package_version_id)
      ORDER BY s.id),'[]'::jsonb) INTO previous_sessions
    FROM meeting_sessions s JOIN rule_package_versions v ON v.id=s.active_rule_package_version_id
    WHERE s.committee_id=target.id AND s.status IN ('OPEN','PENDING')
      AND v.package_id=target.package_id AND v.status='PUBLISHED' AND v.version<12;

    UPDATE committees SET active_rule_package_version_id=target.version_id,revision=revision+1,
      next_event_sequence=next_event_sequence+1,updated_at=now()
    WHERE id=target.id RETURNING revision,next_event_sequence-1 INTO next_revision,event_sequence;

    UPDATE meeting_sessions s SET active_rule_package_version_id=target.version_id,revision=s.revision+1
    FROM rule_package_versions v
    WHERE s.committee_id=target.id AND s.status IN ('OPEN','PENDING')
      AND v.id=s.active_rule_package_version_id AND v.package_id=target.package_id
      AND v.status='PUBLISHED' AND v.version<12;

    INSERT INTO committee_events
      (committee_id,sequence,event_type,resource_type,resource_id,resource_revision,payload,audience)
    VALUES (target.id,event_sequence,'rule_package.activated','rule_package_version',target.version_id,
      next_revision,jsonb_build_object('versionId',target.version_id,'migrationBackfill',true,
        'meetingSessions',previous_sessions),'PUBLIC');

    INSERT INTO audit_log
      (id,request_id,committee_id,actor_user_id,effective_capabilities,action,resource_type,
       resource_id,result,before_summary,after_summary)
    VALUES (gen_random_uuid(),'migration:0084',target.id,NULL,'{}','migration.beijing_rules_upgraded',
      'rule_package_version',target.version_id,'SUCCEEDED',
      jsonb_build_object('versionId',target.previous_version_id,'meetingSessions',previous_sessions),
      jsonb_build_object('versionId',target.version_id,'revision',next_revision));
  END LOOP;
END
$$;

UPDATE quorum_meta.runtime_metadata SET schema_compatibility=84,updated_at=now() WHERE singleton=true;
UPDATE system_settings SET schema_compatibility=84 WHERE singleton=true;
