import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findFeedbackTokens,
  findDontRecommendToken,
  findChannelId,
  findVideoId,
  describeItem,
  ICON_DONT_RECOMMEND_CHANNEL
} from '../Src/youtube/schema.js';

import { buildAuthHeader, readAuthCookie } from '../Src/youtube/auth.js';

const CHANNEL = 'UCMjF_XeJ_kiRq22nz5UXDCQ';

/** Shape measured on the home feed / watch sidebar, client 2.20260805.01.00. */
function modernItem() {
  const listItem = (label, imageName, token) => ({
    listItemViewModel: {
      title: { content: label },
      leadingImage: { sources: [{ clientResource: { imageName } }] },
      rendererContext: {
        commandContext: { onTap: { innertubeCommand: { feedbackEndpoint: { feedbackToken: token } } } }
      }
    }
  });

  return {
    contentId: '3hGEybMtGSQ',
    contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
    metadata: {
      lockupMetadataViewModel: {
        title: { content: 'Some video' },
        metadata: {
          contentMetadataViewModel: {
            metadataRows: [
              {
                metadataParts: [
                  {
                    text: {
                      content: 'Shadow Chronicles',
                      commandRuns: [
                        { onTap: { innertubeCommand: { browseEndpoint: { browseId: CHANNEL } } } }
                      ]
                    }
                  }
                ]
              }
            ]
          }
        },
        menuButton: {
          buttonViewModel: {
            iconName: 'MORE_VERT',
            onTap: {
              innertubeCommand: {
                showSheetCommand: {
                  panelLoadingStrategy: {
                    inlineContent: {
                      sheetViewModel: {
                        content: {
                          listViewModel: {
                            listItems: [
                              listItem('Add to queue', 'ADD_TO_QUEUE_TAIL', undefined),
                              listItem('Not interested', 'HIDE', 'TOKEN_NOT_INTERESTED'),
                              listItem("Don't recommend channel", 'REMOVE', 'TOKEN_DONT_RECOMMEND')
                            ]
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  };
}

/** Shape measured on search results. */
function legacyItem() {
  return {
    videoId: '7jW7A2glZbk',
    longBylineText: {
      runs: [{ navigationEndpoint: { browseEndpoint: { browseId: CHANNEL } } }]
    },
    menu: {
      menuRenderer: {
        items: [
          {
            menuServiceItemRenderer: {
              icon: { iconType: 'ADD_TO_QUEUE_TAIL' },
              text: { simpleText: 'Add to queue' },
              serviceEndpoint: { signalServiceEndpoint: {} }
            }
          },
          {
            menuServiceItemRenderer: {
              icon: { iconType: 'NOT_INTERESTED' },
              text: { simpleText: 'Not interested' },
              serviceEndpoint: { feedbackEndpoint: { feedbackToken: 'LEGACY_NOT_INTERESTED' } }
            }
          },
          {
            menuServiceItemRenderer: {
              icon: { iconType: 'REMOVE' },
              text: { runs: [{ text: "Don't recommend channel" }] },
              serviceEndpoint: { feedbackEndpoint: { feedbackToken: 'LEGACY_DONT_RECOMMEND' } }
            }
          }
        ]
      }
    }
  };
}

test('resolves the modern lockupViewModel schema', () => {
  const tokens = findFeedbackTokens(modernItem());
  assert.equal(tokens.length, 2, 'items without a token must not be reported');

  const dontRecommend = tokens.find((entry) => entry.icon === ICON_DONT_RECOMMEND_CHANNEL);
  assert.equal(dontRecommend.token, 'TOKEN_DONT_RECOMMEND');
  assert.equal(dontRecommend.label, "Don't recommend channel");
});

test('resolves the legacy menuServiceItemRenderer schema', () => {
  const tokens = findFeedbackTokens(legacyItem());
  assert.equal(tokens.length, 2);
  assert.equal(findDontRecommendToken(legacyItem()), 'LEGACY_DONT_RECOMMEND');
});

test('the icon enum, not the label, is what selects the action', () => {
  // A Dutch UI relabels every entry; resolution must be unaffected.
  const dutch = modernItem();
  const items =
    dutch.metadata.lockupMetadataViewModel.menuButton.buttonViewModel.onTap.innertubeCommand
      .showSheetCommand.panelLoadingStrategy.inlineContent.sheetViewModel.content.listViewModel
      .listItems;
  items[1].listItemViewModel.title.content = 'Niet geïnteresseerd';
  items[2].listItemViewModel.title.content = 'Kanaal niet aanbevelen';

  assert.equal(findDontRecommendToken(dutch), 'TOKEN_DONT_RECOMMEND');
});

test('extracts channel and video ids from both schemas', () => {
  assert.equal(findChannelId(modernItem()), CHANNEL);
  assert.equal(findVideoId(modernItem()), '3hGEybMtGSQ');
  assert.equal(findChannelId(legacyItem()), CHANNEL);
  assert.equal(findVideoId(legacyItem()), '7jW7A2glZbk');
});

test('describeItem reports a null token on surfaces that offer no action', () => {
  // Search results and channel pages carry the video but never the feedback item.
  const noMenu = legacyItem();
  delete noMenu.menu;

  assert.deepEqual(describeItem(noMenu), {
    channelId: CHANNEL,
    videoId: '7jW7A2glZbk',
    token: null
  });
});

test('survives the cycles YouTube payloads actually contain', () => {
  const cyclic = modernItem();
  cyclic.self = cyclic;
  cyclic.metadata.parent = cyclic;

  assert.equal(findDontRecommendToken(cyclic), 'TOKEN_DONT_RECOMMEND');
});

test('signs requests in Google SAPISIDHASH form', async () => {
  const cookieString = 'SOCS=abc; SAPISID=SECRET_VALUE; SID=xyz';
  assert.equal(readAuthCookie(cookieString), 'SECRET_VALUE');

  const header = await buildAuthHeader({ now: 1_700_000_000_000, cookieString });
  assert.match(header, /^SAPISIDHASH 1700000000_[0-9a-f]{40}$/);
});

test('refuses to sign when signed out', async () => {
  await assert.rejects(() => buildAuthHeader({ cookieString: 'SOCS=abc' }), /not signed in/);
});
